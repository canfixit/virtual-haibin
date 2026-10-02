import { associatedTokenAddress, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from "./transaction-validator.js";

/** The subset of a `getTransaction` (jsonParsed) response the settlement check reads. Untrusted. */
export type RpcTransaction = {
  slot?: number;
  meta?: { err: unknown } | null;
  transaction?: {
    signatures?: string[];
    message?: {
      recentBlockhash?: string;
      instructions?: Array<{ program?: string; programId?: string; parsed?: { type?: string; info?: Record<string, unknown> } }>;
    };
  };
};

/** The payment facts a settled transaction must carry. */
export type ExpectedSettlement = {
  payer: string;
  payerSignature: string;
  asset: string;
  payTo: string;
  amountAtomic: string;
  blockhash: string;
};

export type SettledTransactionCheck =
  | { status: "not_this_payment" }
  | { status: "facts_mismatch"; transactionId: string; detail: string }
  | { status: "failed_onchain"; transactionId: string; error: string }
  | { status: "settled"; transactionId: string; slot: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure check of one RPC-reported transaction against the expected payment:
 * it must carry the payer's own signature, be bound to the recorded
 * blockhash, and contain a TransferChecked of exactly `amountAtomic` of
 * `asset` from `payer` to payTo's token account. Shared by the authority's
 * reconciliation and the standalone evidence verifier, so both apply the same
 * facts. Payer activity alone is never enough.
 */
export async function checkSettledTransaction(tx: RpcTransaction | null, expected: ExpectedSettlement): Promise<SettledTransactionCheck> {
  if (!tx?.transaction?.signatures?.includes(expected.payerSignature)) {
    return { status: "not_this_payment" };
  }

  const transactionId = tx.transaction.signatures[0] ?? expected.payerSignature;
  const destination = await associatedTokenAddress(expected.payTo, expected.asset, TOKEN_PROGRAM);
  const destination2022 = await associatedTokenAddress(expected.payTo, expected.asset, TOKEN_2022_PROGRAM);
  const factsMatch =
    tx.transaction.message?.recentBlockhash === expected.blockhash &&
    (tx.transaction.message.instructions ?? []).some((ix) => {
      const info = ix.parsed?.info;
      const amount = isRecord(info?.tokenAmount) ? info.tokenAmount.amount : undefined;
      return (
        ix.parsed?.type === "transferChecked" &&
        info?.mint === expected.asset &&
        info?.authority === expected.payer &&
        (info?.destination === destination || info?.destination === destination2022) &&
        amount === expected.amountAtomic
      );
    });

  if (!factsMatch) {
    return { status: "facts_mismatch", transactionId, detail: `transaction ${transactionId} carries the payer signature but its facts do not match` };
  }

  if (tx.meta?.err !== null && tx.meta?.err !== undefined) {
    return { status: "failed_onchain", transactionId, error: JSON.stringify(tx.meta.err) };
  }

  return { status: "settled", transactionId, slot: typeof tx.slot === "number" ? String(tx.slot) : null };
}
