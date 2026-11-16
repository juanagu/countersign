import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
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

/** Undefined when the token is not a valid step-up grant. Rejects when the check itself could not be made. */
export type VerifyStepUp = (token: string) => Promise<StepUpGrant | undefined>;

export const STEP_UP_SCOPE = 'transfers:execute';

const claimsSchema = z.object({
  sub: z.string().min(1),
  scope: z.string().refine((scope) => scope.split(' ').includes(STEP_UP_SCOPE)),
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

/** What jose throws when the token itself is bad; anything else (the IdP's keys unreachable or malformed) is not. */
const TOKEN_REJECTIONS = [
  errors.JWTClaimValidationFailed,
  errors.JWTExpired,
  errors.JWTInvalid,
  errors.JWSInvalid,
  errors.JWSSignatureVerificationFailed,
  errors.JOSEAlgNotAllowed,
  errors.JOSENotSupported,
  errors.JWKSNoMatchingKey,
  errors.JWKSMultipleMatchingKeys,
];

/**
 * Verifies signature, issuer, audience and expiry, then the step-up claims and scope. Undefined for a token that
 * fails them. A failure to reach the IdP's keys rejects instead: it says nothing about the token, so the caller
 * must not treat it as a refusal of the token.
 */
export function createStepUpVerifier({ issuer, audience, keys }: StepUpVerifierOptions): VerifyStepUp {
  return async (token) => {
    const verified = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
      requiredClaims: ['exp'],
    }).catch((error: unknown) => {
      if (TOKEN_REJECTIONS.some((rejection) => error instanceof rejection)) return undefined;
      throw error;
    });
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
