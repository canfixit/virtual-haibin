import {
  address,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getProgramDerivedAddress,
  getTransactionDecoder,
} from "@solana/kit";

/**
 * Pre-transmission check of an x402 `exact` payment transaction.
 *
 * This is a security boundary: the credential built by `ExactSvmScheme` is
 * decoded and checked here *before* it can leave the authority, so a bug or
 * compromise in transaction construction cannot pay anything other than the
 * validated requirement. It is a pure function over the wire bytes and the
 * expected facts, and it fails closed: any structural surprise or decoding
 * error yields `{ valid: false }`; it never throws.
 */

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const TRANSFER_CHECKED = 12;
/** ComputeBudget: SetComputeUnitLimit (2) and SetComputeUnitPrice (3) only. */
const ALLOWED_COMPUTE_BUDGET = new Set([2, 3]);
const MAX_MEMO_BYTES = 256;

export type ExpectedExactPayment = {
  /** Payment wallet (transfer authority + second signer). */
  payer: string;
  /** Facilitator fee payer from the challenge; must be the first account and must not be the payer. */
  feePayer: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  /** Authority-fetched blockhash the transaction must be bound to. */
  blockhash: string;
};

export type TransactionValidation =
  | { valid: true; payerSignature: string; tokenProgram: string }
  | { valid: false; reason: string };

function reject(reason: string): TransactionValidation {
  return { valid: false, reason };
}

export async function associatedTokenAddress(owner: string, mint: string, tokenProgram: string): Promise<string> {
  const encoder = getAddressEncoder();
  const [pda] = await getProgramDerivedAddress({
    programAddress: address(ASSOCIATED_TOKEN_PROGRAM),
    seeds: [encoder.encode(address(owner)), encoder.encode(address(tokenProgram)), encoder.encode(address(mint))],
  });
  return pda;
}

export async function validateExactPaymentTransaction(
  transactionBase64: unknown,
  expected: ExpectedExactPayment,
): Promise<TransactionValidation> {
  try {
    return await validate(transactionBase64, expected);
  } catch (error) {
    return reject(`transaction could not be decoded or checked: ${error instanceof Error ? error.message : "unknown error"}`);
  }
}

async function validate(transactionBase64: unknown, expected: ExpectedExactPayment): Promise<TransactionValidation> {
  if (typeof transactionBase64 !== "string" || transactionBase64.length === 0) {
    return reject("payment payload has no transaction");
  }

  if (expected.feePayer === expected.payer) {
    return reject("payment wallet must not be the fee payer");
  }

  if (!/^(0|[1-9][0-9]{0,19})$/.test(expected.amountAtomic)) {
    return reject("expected amount is not a canonical integer");
  }

  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64));
  const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);

  // The x402 exact client builds v0 messages; anything else is unexpected.
  if (message.version !== 0) {
    return reject(`unexpected transaction message version ${String(message.version)}`);
  }

  if ((message.addressTableLookups ?? []).length > 0) {
    return reject("address lookup tables are not allowed");
  }

  if (message.lifetimeToken !== expected.blockhash) {
    return reject("transaction is not bound to the authority-fetched blockhash");
  }

  const accounts = message.staticAccounts;

  if (accounts[0] !== expected.feePayer) {
    return reject("fee payer is not the challenge's facilitator fee payer");
  }

  // Exactly two signers: the facilitator (fee payer) and the payment wallet.
  if (message.header.numSignerAccounts !== 2 || accounts[1] !== expected.payer) {
    return reject("signers must be exactly the facilitator fee payer and the payment wallet");
  }

  const signatureKeys = Object.keys(transaction.signatures);

  if (signatureKeys.length !== 2 || !signatureKeys.includes(expected.feePayer) || !signatureKeys.includes(expected.payer)) {
    return reject("unexpected signature set");
  }

  const payerSignature = transaction.signatures[expected.payer as keyof typeof transaction.signatures];

  if (!payerSignature) {
    return reject("transaction is not signed by the payment wallet");
  }

  const account = (index: number | undefined): string | undefined => (index === undefined ? undefined : accounts[index]);
  let transfer: { program: string } | null = null;

  for (const instruction of message.instructions) {
    const program = account(instruction.programAddressIndex);
    const data = Uint8Array.from(instruction.data ?? []);
    const instructionAccounts = (instruction.accountIndices ?? []).map(account);

    if (program === COMPUTE_BUDGET_PROGRAM) {
      if (instructionAccounts.length !== 0 || data.length === 0 || !ALLOWED_COMPUTE_BUDGET.has(data[0] ?? -1)) {
        return reject("unexpected compute-budget instruction");
      }
      continue;
    }

    if (program === MEMO_PROGRAM) {
      if (instructionAccounts.length !== 0 || data.length > MAX_MEMO_BYTES) {
        return reject("unexpected memo instruction");
      }
      continue;
    }

    if (program !== TOKEN_PROGRAM && program !== TOKEN_2022_PROGRAM) {
      return reject(`unexpected program ${program ?? "(invalid index)"}`);
    }

    if (transfer !== null) {
      return reject("more than one token instruction");
    }

    if (data.length !== 10 || data[0] !== TRANSFER_CHECKED) {
      return reject("token instruction is not TransferChecked");
    }

    if (instructionAccounts.length !== 4) {
      return reject("TransferChecked has unexpected accounts");
    }

    const amount = new DataView(data.buffer, 1, 8).getBigUint64(0, true);
    const [source, mint, destination, authority] = instructionAccounts;

    if (amount !== BigInt(expected.amountAtomic)) {
      return reject("transfer amount does not match the authorized amount");
    }

    if (mint !== expected.asset) {
      return reject("transfer mint does not match the authorized asset");
    }

    if (authority !== expected.payer) {
      return reject("transfer authority is not the payment wallet");
    }

    if (destination !== (await associatedTokenAddress(expected.payTo, expected.asset, program))) {
      return reject("transfer destination is not payTo's token account");
    }

    if (source !== (await associatedTokenAddress(expected.payer, expected.asset, program))) {
      return reject("transfer source is not the payment wallet's token account");
    }

    transfer = { program };
  }

  if (transfer === null) {
    return reject("no token transfer");
  }

  return { valid: true, payerSignature: getBase58Decoder().decode(payerSignature), tokenProgram: transfer.program };
}
