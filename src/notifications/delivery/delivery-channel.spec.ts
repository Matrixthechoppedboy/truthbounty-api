import {
  parseDeliveryChannel,
  requireDeliveryChannel,
  toWireDeliveryChannel,
} from './delivery-channel';
import { DeliveryChannel } from '../interfaces/notification.types';
import { UnknownDeliveryChannelError } from './delivery-error';

describe('canonical delivery channels', () => {
  it('parses every canonical channel value', () => {
    for (const channel of Object.values(DeliveryChannel)) {
      expect(parseDeliveryChannel(channel)).toBe(channel);
    }
  });

  it('migrates legacy uppercase and alias spellings', () => {
    expect(parseDeliveryChannel('IN_APP')).toBe(DeliveryChannel.IN_APP);
    expect(parseDeliveryChannel('EMAIL')).toBe(DeliveryChannel.EMAIL);
    expect(parseDeliveryChannel('WS')).toBe(DeliveryChannel.WEBSOCKET);
    expect(parseDeliveryChannel('in-app')).toBe(DeliveryChannel.IN_APP);
    expect(parseDeliveryChannel('  Webhook  ')).toBe(DeliveryChannel.WEBHOOK);
  });

  it('returns null for null, empty, and unknown values', () => {
    for (const value of [
      null,
      undefined,
      '',
      '   ',
      'carrier-pigeon',
      42,
      {},
    ]) {
      expect(parseDeliveryChannel(value)).toBeNull();
    }
  });

  it('fails closed when requiring a channel', () => {
    expect(() => requireDeliveryChannel(null)).toThrow(
      UnknownDeliveryChannelError,
    );
    expect(() => requireDeliveryChannel('carrier-pigeon')).toThrow(
      UnknownDeliveryChannelError,
    );
    expect(requireDeliveryChannel('EMAIL')).toBe(DeliveryChannel.EMAIL);
  });

  it('serializes with a single wire representation', () => {
    expect(toWireDeliveryChannel(DeliveryChannel.EMAIL)).toBe('email');
    expect(toWireDeliveryChannel(DeliveryChannel.SMS)).toBe('sms');
  });
});
