import { Global, Module } from '@nestjs/common';
import { AddNumbersTool } from './builtin/add-numbers.tool';
import { BrowseTool } from './builtin/browse.tool';
import { FetchPageTool } from './builtin/fetch-page.tool';
import { GetCurrentTimeTool } from './builtin/get-current-time.tool';
import { SearchWebTool } from './builtin/search-web.tool';
import { PageDeclutterService } from './declutter.service';
import { SearchRerankerService } from './search-reranker.service';
import { ToolRegistry } from './tool-registry';

@Global()
@Module({
  providers: [
    ToolRegistry,
    PageDeclutterService,
    SearchRerankerService,
    GetCurrentTimeTool,
    AddNumbersTool,
    SearchWebTool,
    FetchPageTool,
    BrowseTool,
  ],
  exports: [ToolRegistry],
})
export class ToolsModule {}
