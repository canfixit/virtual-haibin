import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { associatedTokenAddress, TOKEN_PROGRAM } from "./transaction-validator.js";

/**
 * Verifies, offline, that `payer` produced its signature in the wire
 * transaction over exactly that transaction's message bytes. Together with
 * validateExactPaymentTransaction this establishes "the payment wallet signed
 * exactly this transfer" without any network access. Fails closed.
 */
export async function verifyTransactionPayerSignature(transactionBase64: string, payer: string): Promise<boolean> {
  try {
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
    const signature = transaction.signatures[payer as keyof typeof transaction.signatures];

    if (!signature) {
      return false;
    }

    const publicKey = await getPublicKeyFromAddress(address(payer));
    return await verifySignature(publicKey, signature, transaction.messageBytes);
  } catch {
    return false;
  }
}

/**
 * TEST/DEV ONLY. Builds a partially signed x402-`exact`-shaped transaction
 * (compute limit + TransferChecked + memo, facilitator fee payer, payer as
 * the second signer). Used by MockPaymentProvider so hermetic tests carry a
 * real, independently checkable payment transaction. Never used on the real
 * payment path, which builds transactions with @x402/svm's ExactSvmScheme.
 */
export async function buildExactPaymentTransactionForTests(input: {
  payer: KeyPairSigner;
  feePayer: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  blockhash: string;
  memo: string;
}): Promise<string> {
  const amount = new Uint8Array(8);
  new DataView(amount.buffer).setBigUint64(0, BigInt(input.amountAtomic), true);
  const mint = address(input.asset);

  const transfer = {
    programAddress: address(TOKEN_PROGRAM),
    accounts: [
      { address: address(await associatedTokenAddress(input.payer.address, input.asset, TOKEN_PROGRAM)), role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: address(await associatedTokenAddress(input.payTo, input.asset, TOKEN_PROGRAM)), role: AccountRole.WRITABLE },
      { address: input.payer.address, role: AccountRole.READONLY_SIGNER, signer: input.payer },
    ],
    data: new Uint8Array([12, ...amount, 6]),
  } as Instruction;
  const computeLimit: Instruction = { programAddress: address("ComputeBudget111111111111111111111111111111"), data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) };
  const memo: Instruction = { programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), data: new TextEncoder().encode(input.memo) };

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayer(address(input.feePayer), tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(input.blockhash), lastValidBlockHeight: 1000n }, tx),
    (tx) => appendTransactionMessageInstructions([computeLimit, transfer, memo], tx),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}
