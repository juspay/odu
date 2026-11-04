/**
 * `@odu/objects` — the one door. See the package README.
 */
export {
  type ByteRange,
  type CopyOptions,
  directUploads,
  type DirectStore,
  factsCounter,
  type ObjectBody,
  type ObjectFacts,
  type ObjectRefusal,
  type ObjectStore,
  type PutOptions,
  type PutOutcome,
  sameFacts,
  type StoredObject,
  /** The prefix a key that is not an object yet carries — what a direct
   *  upload writes to before anybody has proved its bytes. */
  TEMP,
  UnrecordedObject,
  type UploadedPart,
  type WriteDecision,
} from "./objectStore";
export { diskObjectStore, type DiskObjectStoreOptions } from "./diskStore";
export { s3ObjectStore, type S3ObjectStoreOptions } from "./s3Store";
export { s3Fetch, type S3Request, type S3Target } from "./s3sign";
export {
  type DeclarationRefusal,
  type DeclarationsParse,
  parseStoreDeclarations,
  type S3Declaration,
  type StoreDeclarations,
} from "./declarations";
