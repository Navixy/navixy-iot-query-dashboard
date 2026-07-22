import { getServiceTranslator } from '@/i18n/serviceTranslator';

/**
 * Accepted error shapes: plain string, structured object with optional
 * PostgreSQL `sqlCode` in `details`, or the ApiResponse `error` envelope.
 */
export type SqlErrorLike = {
  code?: string;
  message?: string;
  details?: unknown;
};

function normalizeMessage(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/**
 * The raw DB/driver detail is a lowercase sentence (e.g. Postgres'
 * `column "category" does not exist`); capitalize its first letter so it reads
 * cleanly after our friendly prefix. Otherwise left verbatim — it is DB output,
 * not translatable text.
 */
function capitalizeDetail(message: string): string {
  return message ? message.charAt(0).toUpperCase() + message.slice(1) : message;
}

/**
 * Convert low-level SQL/driver errors into user-friendly, localized messages.
 * Runs in non-React code (the API client, thrown-error paths), so it resolves
 * the active translator via the service-translator bridge rather than a hook.
 */
export function interpretSqlError(error: SqlErrorLike | string | undefined | null): string {
  const t = getServiceTranslator();

  if (!error) {
    return t('errors.sql.query_failed.paragraph.failure');
  }

  const rawMessage = typeof error === 'string' ? error : (error.message || '');
  const message = normalizeMessage(rawMessage);
  const code = typeof error === 'string' ? undefined : error.code;
  const sqlCode = typeof error === 'string' ? undefined : ((error.details as Record<string, unknown> | undefined)?.sqlCode as string | undefined);
  const lowered = message.toLowerCase();

  // detail = the raw DB message (capitalized) when present, else a friendly fallback.
  const detailOr = (fallbackKey: string) => (message ? capitalizeDetail(message) : t(fallbackKey));

  if (sqlCode === '22P02' || lowered.includes('invalid input syntax')) {
    return t('errors.sql.invalid_value.paragraph.failure', { detail: detailOr('errors.sql.invalid_value.fallback.instruction') });
  }

  if (sqlCode === '42601' || lowered.includes('syntax error')) {
    return t('errors.sql.syntax_error.paragraph.failure', { detail: detailOr('errors.sql.syntax_error.fallback.instruction') });
  }

  if (sqlCode === '42703' || (lowered.includes('column') && lowered.includes('does not exist'))) {
    return t('errors.sql.unknown_column.paragraph.failure', { detail: detailOr('errors.sql.unknown_column.fallback.instruction') });
  }

  if (sqlCode === '42P01' || (lowered.includes('relation') && lowered.includes('does not exist'))) {
    return t('errors.sql.table_not_found.paragraph.failure', { detail: detailOr('errors.sql.table_not_found.fallback.instruction') });
  }

  if (sqlCode === '42883' || (lowered.includes('function') && lowered.includes('does not exist'))) {
    return t('errors.sql.function_mismatch.paragraph.failure', { detail: detailOr('errors.sql.function_mismatch.fallback.instruction') });
  }

  if (sqlCode === '42501' || lowered.includes('permission denied')) {
    return t('errors.sql.insufficient_privileges.paragraph.failure', { detail: detailOr('errors.sql.insufficient_privileges.fallback.instruction') });
  }

  if (sqlCode === '23505' || lowered.includes('unique constraint') || lowered.includes('duplicate key')) {
    return t('errors.sql.duplicate_key.paragraph.failure', { detail: detailOr('errors.sql.duplicate_key.fallback.instruction') });
  }

  if (sqlCode === '23503' || lowered.includes('foreign key constraint')) {
    return t('errors.sql.foreign_key.paragraph.failure', { detail: detailOr('errors.sql.foreign_key.fallback.instruction') });
  }

  if (code === 'NETWORK_ERROR' || lowered.includes('network')) {
    return t('errors.sql.network.paragraph.failure', { detail: detailOr('errors.sql.network.fallback.instruction') });
  }

  if (sqlCode === '57014' || lowered.includes('timeout') || lowered.includes('canceling statement due to statement timeout')) {
    return t('errors.sql.timeout.paragraph.failure', { detail: detailOr('errors.sql.timeout.fallback.instruction') });
  }

  if (!message) {
    return t('errors.sql.query_failed.paragraph.failure');
  }

  // Unknown error type: show the raw DB message, capitalized for readability.
  return capitalizeDetail(message);
}
