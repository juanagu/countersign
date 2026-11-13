import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';

/** The single transfer a step-up token authorises (RFC 9396 `authorization_details`). */
export interface TransferAuthorization {
  draftId: string;
  amount: string;
  currency: string;
  beneficiaryId: string;
}

export interface StepUpGrant {
  sub: string;
  jti: string;
  authorization: TransferAuthorization;
}

export type VerifyStepUp = (token: string) => Promise<StepUpGrant | undefined>;

const claimsSchema = z.object({
  sub: z.string().min(1),
  jti: z.string().min(1),
  token_use: z.literal('step_up'),
  authorization_details: z
    .array(
      z.object({
        type: z.literal('transfer'),
        draft_id: z.string(),
        amount: z.string(),
        currency: z.string(),
        beneficiary_id: z.string(),
      }),
    )
    .length(1),
});

export interface StepUpVerifierOptions {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
}

/** Verifies signature, issuer, audience and expiry, then the step-up claims. Undefined for any failure. */
export function createStepUpVerifier({ issuer, audience, keys }: StepUpVerifierOptions): VerifyStepUp {
  return async (token) => {
    const verified = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
      requiredClaims: ['exp'],
    }).catch(() => undefined);
    const claims = claimsSchema.safeParse(verified?.payload);
    if (!claims.success) return undefined;
    const [details] = claims.data.authorization_details;
    if (!details) return undefined;
    return {
      sub: claims.data.sub,
      jti: claims.data.jti,
      authorization: {
        draftId: details.draft_id,
        amount: details.amount,
        currency: details.currency,
        beneficiaryId: details.beneficiary_id,
      },
    };
  };
}
