import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

export interface VerifiedIdentity {
  userId: string;
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
        payload: { sub: 'dev-user', iss: 'dev-bypass' },
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
    return { userId: sub, payload };
  }
}
