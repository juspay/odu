/**
 * `@odu/objects/testing` — what a consumer's suite needs to run its own cases
 * against a real S3 service: the versitygw gateway. Test-only; nothing the
 * package ships imports it.
 */
export { type Gateway, startGateway } from "./versitygw";
