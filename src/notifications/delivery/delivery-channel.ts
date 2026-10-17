import { DeliveryChannel } from '../interfaces/notification.types';
import { UnknownDeliveryChannelError } from './delivery-error';

/**
 * Accepted channel spellings. The canonical enum values are the persisted/wire
 * representation; the remaining entries are documented legacy aliases that
 * either migrate to a canonical value or (when unmapped) fail closed.
 */
const CHANNEL_ALIASES: Readonly<Record<string, DeliveryChannel>> = {
  [DeliveryChannel.IN_APP]: DeliveryChannel.IN_APP,
  inapp: DeliveryChannel.IN_APP,
  'in-app': DeliveryChannel.IN_APP,
  [DeliveryChannel.WEBSOCKET]: DeliveryChannel.WEBSOCKET,
  ws: DeliveryChannel.WEBSOCKET,
  socket: DeliveryChannel.WEBSOCKET,
  [DeliveryChannel.EMAIL]: DeliveryChannel.EMAIL,
  mail: DeliveryChannel.EMAIL,
  [DeliveryChannel.PUSH]: DeliveryChannel.PUSH,
  [DeliveryChannel.WEBHOOK]: DeliveryChannel.WEBHOOK,
  [DeliveryChannel.SMS]: DeliveryChannel.SMS,
  text: DeliveryChannel.SMS,
};

/**
 * Normalize an untrusted channel value to the canonical enum.
 *
 * Returns `null` for `null`, `undefined`, empty, and unknown values so callers
 * can fail closed before a provider is ever selected. Legacy uppercase spellings
 * (`IN_APP`) are migrated case-insensitively rather than rejected.
 */
export function parseDeliveryChannel(value: unknown): DeliveryChannel | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0) {
    return null;
  }

  return CHANNEL_ALIASES[normalized] ?? null;
}

/**
 * The canonical channel value is already the wire representation. This helper
 * exists so serialization has one documented entry point instead of scattered
 * `String(channel)`/`toUpperCase()` calls.
 */
export function toWireDeliveryChannel(channel: DeliveryChannel): string {
  return channel;
}

/**
 * Parse or throw a terminal `UnknownDeliveryChannelError`.
 *
 * Used at the boundary of the delivery worker so a null/unknown channel can
 * never be silently coerced into a provider call.
 */
export function requireDeliveryChannel(value: unknown): DeliveryChannel {
  const canonical = parseDeliveryChannel(value);
  if (canonical === null) {
    throw new UnknownDeliveryChannelError(
      `Unknown or missing delivery channel: ${describeChannelValue(value)}`,
    );
  }
  return canonical;
}

/** Render an untrusted channel value for a sanitized error message. */
function describeChannelValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value.length === 0 ? '<empty>' : value;
  return typeof value;
}
