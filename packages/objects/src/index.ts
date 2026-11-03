/**
 * `@odu/objects` — the one door. See the package README.
 */
export {
  type ByteRange,
  factsCounter,
  type ObjectBody,
  type ObjectFacts,
  type ObjectRefusal,
  type ObjectStore,
  type PutOptions,
  type PutOutcome,
  sameFacts,
  type StoredObject,
  UnrecordedObject,
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
