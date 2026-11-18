import "server-only";

import { create } from "@zitadel/client";
import {
  RequestChallenges,
  RequestChallenges_OTPEmail_SendCodeSchema,
} from "@zitadel/proto/zitadel/session/v2/challenge_pb";

/**
 * Strips the `returnCode` delivery type from a client-supplied challenge request.
 *
 * `returnCode` makes Zitadel return the freshly generated OTP in plaintext in the response
 * body instead of sending it to the user's mailbox or phone. It is a legitimate API feature
 * for callers that deliver the code themselves, but this app proxies requests on behalf of
 * an untrusted browser: anything it forwards is attacker-controllable, and anything it
 * returns is attacker-readable.
 *
 * Without this, a party who knows only a victim's login name could request both OTP-Email
 * and OTP-SMS challenges on an identify-only session, read both codes straight out of the
 * server-action response and submit them back as two verified factors — GHSA-3gwm-5wx8-4gm6.
 *
 * OTP challenges are rewritten to their out-of-band equivalent rather than dropped, so the
 * legitimate 2FA flow still completes and the code reaches the actual user. WebAuthN
 * challenges carry no code and are passed through untouched.
 */
export function sanitizeChallenges(challenges?: RequestChallenges): RequestChallenges | undefined {
  if (!challenges) {
    return challenges;
  }

  const sanitized = { ...challenges };

  if (sanitized.otpSms) {
    sanitized.otpSms = { ...sanitized.otpSms, returnCode: false };
  }

  if (sanitized.otpEmail?.deliveryType?.case === "returnCode") {
    sanitized.otpEmail = {
      ...sanitized.otpEmail,
      // fall back to the default Zitadel verification url
      deliveryType: { case: "sendCode", value: create(RequestChallenges_OTPEmail_SendCodeSchema, {}) },
    };
  }

  return sanitized;
}

const DEFAULT_OTP_RESEND_COOLDOWN_SECONDS = 30;

// a value that is not a non-negative integer falls back to the default, `0` disables the cooldown
function parseCooldownSeconds(configured: string | undefined): number {
  const trimmed = configured?.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return DEFAULT_OTP_RESEND_COOLDOWN_SECONDS;
  }
  return Number(trimmed);
}

function getRetryAfterSeconds(sentTs: string | undefined, cooldownSeconds: number, now: number): number {
  const sentAt = Number(sentTs);
  if (!sentTs || !Number.isFinite(sentAt)) {
    return 0;
  }

  const remainingSeconds = Math.ceil((sentAt + cooldownSeconds * 1000 - now) / 1000);
  // a timestamp in the future can only come from clock skew between replicas, cap it at the full cooldown
  return Math.min(Math.max(remainingSeconds, 0), cooldownSeconds);
}

/**
 * Minimum number of seconds between two OTP SMS challenges on the same session.
 *
 * Every OTP SMS challenge makes Zitadel send a text message. Without a cooldown a user (or a script)
 * can hit "resend" in a loop and flood the user's phone with codes.
 *
 * Configurable via `OTP_SMS_RESEND_COOLDOWN_SECONDS`, defaults to 30. `0` disables the cooldown;
 * anything that is not a non-negative integer falls back to the default.
 */
export function getOTPSMSResendCooldownSeconds(): number {
  return parseCooldownSeconds(process.env.OTP_SMS_RESEND_COOLDOWN_SECONDS);
}

/**
 * Returns how many seconds are left until another OTP SMS may be sent, or 0 if one may be sent now.
 *
 * @param otpSmsSentTs the `otpSmsSentTs` (ms since epoch) of the session cookie entry
 */
export function getOTPSMSRetryAfterSeconds(otpSmsSentTs: string | undefined, now: number = Date.now()): number {
  return getRetryAfterSeconds(otpSmsSentTs, getOTPSMSResendCooldownSeconds(), now);
}

/**
 * Minimum number of seconds between two OTP e-mail challenges on the same session, so reloading the
 * code page or clicking "resend" in a loop does not send a mail each time (each new code invalidates
 * the previous one).
 *
 * Configurable via `OTP_EMAIL_RESEND_COOLDOWN_SECONDS`, defaults to 30. `0` disables the cooldown;
 * anything that is not a non-negative integer falls back to the default.
 */
export function getOTPEmailResendCooldownSeconds(): number {
  return parseCooldownSeconds(process.env.OTP_EMAIL_RESEND_COOLDOWN_SECONDS);
}

/**
 * Returns how many seconds are left until another OTP e-mail may be sent, or 0 if one may be sent now.
 *
 * @param otpEmailSentTs the `otpEmailSentTs` (ms since epoch) of the session cookie entry
 */
export function getOTPEmailRetryAfterSeconds(otpEmailSentTs: string | undefined, now: number = Date.now()): number {
  return getRetryAfterSeconds(otpEmailSentTs, getOTPEmailResendCooldownSeconds(), now);
}

/**
 * Thrown when a session was updated, so the requested challenges were already sent, but a step after
 * the update failed. Callers must not request the same challenges again, the user already has the code.
 */
export class SessionUpdatedError extends Error {
  constructor(cause: unknown) {
    super("session was updated, but the steps after the update failed", { cause });
    this.name = "SessionUpdatedError";
  }
}
