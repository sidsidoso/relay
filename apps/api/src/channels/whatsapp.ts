import type { Channel } from './types'

/** v2: WhatsApp Cloud API connector. v1 ships only the contract so the core stays channel-agnostic. */
export class WhatsAppChannel implements Channel {
  readonly id = 'whatsapp' as const
  async send(_target: Parameters<Channel['send']>[0], _message: Parameters<Channel['send']>[1]): Promise<void> {
    throw new Error('WhatsApp channel is not enabled')
  }
}
