import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface VerifiedIdentity {
  userId: string;
  // OAuth client_id from the JWT — the app that holds this token.
  // In multi-tenant terms this is the tenant. Sourced from the
  // `client_id` claim (oidc-provider's standard JWT access-token
  // claim), or `azp` as a fallback for confidential-client flows.
  clientId: string;
  payload: JWTPayload;
}

/**
 * Verifies JWTs issued by the IdP (idpbase.swirlock.com) against its
 * JWKS. The issuer + audience are pinned via env so a token from a
 * different audience (e.g. another service's URL) is rejected.
 *
 * In dev, DEV_BYPASS_AUTH=true short-circuits to a deterministic fake
 * user — useful for local smoke tests. Production runtime must leave
 * this off; we log a loud warning on boot when it is set.
 */
@Injectable()
export class JwtVerifierService implements OnModuleInit {
  private readonly logger = new Logger(JwtVerifierService.name);

  private issuer!: string;
  private audience!: string;
  private jwks!: ReturnType<typeof createRemoteJWKSet>;
  private bypass = false;

  onModuleInit(): void {
    this.bypass = process.env.DEV_BYPASS_AUTH === 'true';

    if (this.bypass) {
      this.logger.warn(
        'DEV_BYPASS_AUTH=true — JWT verification is OFF. Do not run this mode anywhere users connect from.',
      );
      return;
    }

    const issuer = process.env.IDP_ISSUER;
    const audience = process.env.IDP_AUDIENCE;
    if (!issuer || !audience) {
      throw new Error('IDP_ISSUER and IDP_AUDIENCE must be set');
    }
    this.issuer = issuer;
    this.audience = audience;
    const jwksUri = `${issuer.replace(/\/$/, '')}/jwks`;
    this.jwks = createRemoteJWKSet(new URL(jwksUri));
    this.logger.log(
      `JWT verifier configured: issuer=${issuer} audience=${audience} jwks=${jwksUri}`,
    );
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    if (this.bypass) {
      return {
        userId: 'dev-user',
        clientId: 'dev',
        payload: { sub: 'dev-user', client_id: 'dev', iss: 'dev-bypass' },
      };
    }
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.issuer,
      audience: this.audience,
    });
    const sub = typeof payload.sub === 'string' ? payload.sub : null;
    if (!sub) {
      throw new Error('JWT has no sub claim');
    }
    // Prefer `client_id` (oidc-provider's standard access-token claim);
    // fall back to `azp` (the OIDC "authorized party" claim, set when
    // a confidential client is used). Reject the token if neither is
    // present — a session with no owning client can't be filed.
    const clientId =
      (typeof payload['client_id'] === 'string'
        ? (payload['client_id'] as string)
        : null) ??
      (typeof payload['azp'] === 'string' ? (payload['azp'] as string) : null);
    if (!clientId) {
      throw new Error('JWT has no client_id / azp claim');
    }
    return { userId: sub, clientId, payload };
  }
}
