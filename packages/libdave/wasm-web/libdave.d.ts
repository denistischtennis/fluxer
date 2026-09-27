// TypeScript bindings for emscripten-generated code.  Automatically generated at compile time.
declare namespace RuntimeExports {
    /**
     * @param {string|null=} returnType
     * @param {Array=} argTypes
     * @param {Arguments|Array=} args
     * @param {Object=} opts
     */
    function ccall(ident: any, returnType?: (string | null) | undefined, argTypes?: any[] | undefined, args?: (Arguments | any[]) | undefined, opts?: any | undefined): any;
    let HEAPF32: any;
    let HEAPF64: any;
    let HEAP_DATA_VIEW: any;
    let HEAP8: any;
    let HEAPU8: any;
    let HEAP16: any;
    let HEAPU16: any;
    let HEAP32: any;
    let HEAPU32: any;
    let HEAP64: any;
    let HEAPU64: any;
}
interface WasmModule {
  _malloc(_0: number): number;
  _free(_0: number): void;
}

type EmbindString = ArrayBuffer|Uint8Array|Uint8ClampedArray|Int8Array|string;
export interface MediaTypeValue<T extends number> {
  value: T;
}
export type MediaType = MediaTypeValue<0>|MediaTypeValue<1>;

export interface CodecValue<T extends number> {
  value: T;
}
export type Codec = CodecValue<0>|CodecValue<1>|CodecValue<2>|CodecValue<3>|CodecValue<4>|CodecValue<5>|CodecValue<6>;

export interface SignaturePrivateKey {
  delete(): void;
}

export interface TransientKeys {
  GetTransientPrivateKey(_0: number): SignaturePrivateKey;
  Clear(): void;
  delete(): void;
}

export interface Session {
  Init(_0: number, _1: bigint, _2: EmbindString, _3: SignaturePrivateKey): void;
  Reset(): void;
  SetProtocolVersion(_0: number): void;
  GetProtocolVersion(): number;
  GetLastEpochAuthenticator(): any;
  SetExternalSender(_0: any): void;
  ProcessProposals(_0: any, _1: any): any;
  ProcessCommit(_0: any): any;
  ProcessWelcome(_0: any, _1: any): any;
  GetMarshalledKeyPackage(): any;
  GetKeyRatchet(_0: EmbindString): any;
  delete(): void;
}

export interface Encryptor {
  SetKeyRatchet(_0: any): void;
  SetPassthroughMode(_0: boolean): void;
  AssignSsrcToCodec(_0: number, _1: Codec): void;
  GetProtocolVersion(): number;
  GetMaxCiphertextByteSize(_0: MediaType, _1: number): number;
  Encrypt(_0: MediaType, _1: number, _2: number, _3: number, _4: number): number;
  SetProtocolVersionChangedCallback(_0: any): void;
  delete(): void;
}

export interface Decryptor {
  TransitionToKeyRatchet(_0: any): void;
  TransitionToPassthroughMode(_0: boolean): void;
  GetMaxPlaintextByteSize(_0: MediaType, _1: number): number;
  Decrypt(_0: MediaType, _1: number, _2: number, _3: number): number;
  delete(): void;
}

interface EmbindModule {
  kInitTransitionId: number;
  kDisabledVersion: number;
  MediaType: {Audio: MediaTypeValue<0>, Video: MediaTypeValue<1>};
  Codec: {Unknown: CodecValue<0>, Opus: CodecValue<1>, VP8: CodecValue<2>, VP9: CodecValue<3>, H264: CodecValue<4>, H265: CodecValue<5>, AV1: CodecValue<6>};
  MaxSupportedProtocolVersion(): number;
  SignaturePrivateKey: {};
  TransientKeys: {new(): TransientKeys};
  Session: {new(_0: EmbindString, _1: EmbindString, _2: any): Session};
  Encryptor: {new(): Encryptor};
  Decryptor: {new(): Decryptor};
}

export type MainModule = WasmModule & typeof RuntimeExports & EmbindModule;
export default function MainModuleFactory (options?: unknown): Promise<MainModule>;
