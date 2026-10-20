import type {NativeModule} from '@rnrs/runtime/spec';

/** CRC-32 (IEEE) from the crc32fast crate. */
export interface CrcModule extends NativeModule {
  /** The checksum of the bytes. */
  crc32(data: ArrayBuffer): number;
  /** The checksum of the UTF-8 text, as 8 lowercase hex digits. */
  crc32Hex(text: string): string;
}
