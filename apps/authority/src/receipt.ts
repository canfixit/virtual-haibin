// The authorization receipt format lives in @virtual-haibin/evidence so the
// standalone verifier can check it without the authority.
export {
  AUTHORIZATION_RECEIPT_DOMAIN,
  AUTHORIZATION_RECEIPT_VERSION,
  AUTHORIZATION_RECEIPT_VERSION_2,
  signAuthorizationReceipt,
  verifyAuthorizationReceiptSignature,
} from "@virtual-haibin/evidence";
export type {
  AuthorizationReceiptSignature,
  SignedAuthorizationReceipt,
  SignedAuthorizationReceiptV1,
  SignedAuthorizationReceiptV2,
  UnsignedAuthorizationReceipt,
  UnsignedAuthorizationReceiptV1,
  UnsignedAuthorizationReceiptV2,
} from "@virtual-haibin/evidence";
