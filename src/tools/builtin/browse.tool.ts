import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { Browser } from 'playwright';
import { z } from 'zod';
import { PageDeclutterService } from '../declutter.service';
import { ToolRegistry } from '../tool-registry';

const inputSchema = z.object({
  url: z.string().url().describe('The URL to load in a real Chromium browser.'),
  full_page: z
    .boolean()
    .optional()
    .describe(
      'Capture full-page screenshot (true) or viewport only (false). Default false.',
    ),
  wait_ms: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .optional()
    .describe('Extra milliseconds to wait after networkidle. Default 500.'),
});

type Input = z.infer<typeof inputSchema>;

interface LinkRecord {
  href: string;
  text: string;
}

interface RawOutput {
  url: string;
  title: string | null;
  status: number;
  text: string;
  text_length: number;
  text_truncated: boolean;
  links: LinkRecord[];
  screenshot_base64: string;
  load_time_ms: number;
}

/**
 * Loads a URL in a real headless Chromium browser, waits for JS to
 * render, extracts text + links + a screenshot. The screenshot is
 * delivered to the model as image-data via `toModelOutput`, so a
 * vision-capable model (Anthropic Haiku/Sonnet/Opus 4.x) can describe
 * the rendered page directly. Non-vision models still receive the
 * extracted text + link list.
 *
 * The browser is launched lazily on first call and reused across
 * tool invocations. A fresh BrowserContext is opened per call so
 * cookies / localStorage don't leak between unrelated pages.
 */
@Injectable()
export class BrowseTool implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BrowseTool.name);
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  constructor(
    private readonly registry: ToolRegistry,
    private readonly declutter: PageDeclutterService,
  ) {}

  onModuleInit(): void {
    const maxTextLength = Number(process.env.BROWSE_MAX_TEXT_LENGTH ?? '12000');
    const maxLinks = Number(process.env.BROWSE_MAX_LINKS ?? '40');
    const userAgent =
      process.env.BROWSE_USER_AGENT ??
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
    const navTimeoutMs = Number(process.env.BROWSE_NAV_TIMEOUT_MS ?? '30000');

    this.registry.register<Input, RawOutput>({
      name: 'browse',
      description: [
        'Loads a URL in a real headless Chromium browser, waits for JS',
        'to render, then returns the rendered page text, a list of links,',
        'and a screenshot. Use this when fetch_page does not work because',
        'the page is JavaScript-heavy (single-page apps, dynamic loaders),',
        'or when you need to SEE the visual layout (product grids,',
        'advertisements, banners, infographics, hero sections).',
        '',
        'WHEN TO CALL:',
        '- The user asks you to analyse a website visually (layout, design,',
        '  branding, where elements are positioned).',
        '- search_web returned a URL whose snippet was empty or unhelpful',
        '  and fetch_page also returned thin content.',
        '- The page is a single-page application that needs JavaScript to',
        '  render real content.',
        '- You need the screenshot to compare two pages, identify visual',
        '  elements, or describe what a human sees on first impression.',
        '',
        'WHEN NOT TO CALL:',
        '- A simple article or blog post — fetch_page is cheaper, faster,',
        '  and gets you the same text content.',
        '- A page where you already have all the answer text from a prior',
        '  fetch_page call and a screenshot would add nothing.',
        '- A page that requires logging in or filling a form (we cannot',
        '  interact with the page beyond loading it).',
        '',
        'MULTI-PAGE CRAWL PATTERN:',
        '- For analysing a whole site, start with the homepage. Read the',
        '  returned `links` list, pick 2-5 categorically-distinct links',
        '  (different category pages, an about page, a contact page), and',
        '  browse each individually. Compare what you see.',
        '- Do NOT crawl recursively without a clear goal — each browse',
        '  call takes several seconds and uses real resources.',
        '',
        'PARAMETERS:',
        '- url: the URL to load (must be a valid http(s) URL).',
        '- full_page: when true, the screenshot scrolls the entire',
        '  document; default false (just the visible viewport, faster).',
        '- wait_ms: extra ms to wait after the network goes idle before',
        '  extracting text + taking the screenshot. Default 500ms.',
        '',
        'OUTPUT (delivered as image + text content to the model):',
        '- A PNG screenshot of the rendered page.',
        '- Page title, HTTP status, load time.',
        '- Extracted body text (truncated at the configured cap).',
        '- Up to a configured number of anchor links with their visible',
        '  text — your map for the next browse call.',
      ].join('\n'),
      inputSchema,
      execute: async (input: Input): Promise<RawOutput> => {
        const browser = await this.ensureBrowser();
        const context = await browser.newContext({ userAgent });
        const page = await context.newPage();
        const t0 = Date.now();
        try {
          const response = await page.goto(input.url, {
            waitUntil: 'networkidle',
            timeout: navTimeoutMs,
          });
          const status = response?.status() ?? 0;
          await page.waitForTimeout(input.wait_ms ?? 500);

          const title = await page.title();
          const rawText = await page.evaluate(() => document.body.innerText);
          // Strip navigation / ads / related-article teasers via the
          // same Haiku pre-filter used by fetch_page. The screenshot
          // is still delivered raw so vision can see the actual page.
          const declutterResult = await this.declutter.declutter(
            rawText,
            page.url(),
          );
          const text = declutterResult.text;
          const truncated = text.length > maxTextLength;
          const textOut = truncated ? text.slice(0, maxTextLength) : text;

          const links = await page.evaluate((limit: number) => {
            const anchors = Array.from(
              document.querySelectorAll('a[href]'),
            ).slice(0, limit);
            return anchors.map((a) => {
              const el = a as HTMLAnchorElement;
              return {
                href: el.href,
                text: (el.innerText || el.textContent || '').trim().slice(0, 100),
              };
            });
          }, maxLinks);

          const screenshot = await page.screenshot({
            fullPage: input.full_page ?? false,
            type: 'png',
          });

          return {
            url: page.url(),
            title: title || null,
            status,
            text: textOut,
            text_length: rawText.length,
            text_truncated: truncated,
            links,
            screenshot_base64: screenshot.toString('base64'),
            load_time_ms: Date.now() - t0,
          };
        } finally {
          await context.close();
        }
      },
      toModelOutput: (output) => {
        // Two-part content block: the screenshot as image-data so
        // a vision-capable model can see the rendered page, plus a
        // text block with title/links/extracted text so non-vision
        // models still get the structured information.
        const summary = [
          `URL: ${output.url}`,
          `Title: ${output.title ?? '—'}`,
          `Status: ${output.status}, loaded in ${output.load_time_ms} ms`,
          '',
          `Body text (${output.text_length} chars${output.text_truncated ? ', truncated to cap' : ''}):`,
          output.text,
          '',
          `Links found (${output.links.length}):`,
          ...output.links.map((l) => `- "${l.text}" → ${l.href}`),
        ].join('\n');

        return {
          type: 'content',
          value: [
            {
              type: 'image-data',
              data: output.screenshot_base64,
              mediaType: 'image/png',
            },
            {
              type: 'text',
              text: summary,
            },
          ],
        };
      },
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser && this.browser.isConnected()) {
      return this.browser;
    }
    if (!this.launchPromise) {
      this.launchPromise = (async () => {
        const { chromium } = await import('playwright');
        this.logger.log('launching Chromium for browse tool');
        const b = await chromium.launch({ headless: true });
        b.on('disconnected', () => {
          this.logger.warn('Chromium disconnected; will relaunch on next call');
          this.browser = null;
          this.launchPromise = null;
        });
        this.browser = b;
        return b;
      })();
    }
    return this.launchPromise;
  }
}
