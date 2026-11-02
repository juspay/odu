/**
 * `@odu/objects` — the one door. See the package README.
 */
export {
  type ByteRange,
  diskObjectStore,
  type DiskObjectStoreOptions,
  type ObjectBody,
  type ObjectFacts,
  type ObjectRefusal,
  type ObjectStore,
  type PutOutcome,
  s3ObjectStore,
  type S3ObjectStoreOptions,
  type StoredObject,
  UnrecordedObject,
} from "./objectStore";
export { s3Fetch, type S3Request, type S3Target } from "./s3sign";
export {
  type DeclarationRefusal,
  type DeclarationsParse,
  parseStoreDeclarations,
  type S3Declaration,
  type StoreDeclarations,
} from "./declarations";
