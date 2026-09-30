import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash as toBlockhash,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  associatedTokenAddress,
  COMPUTE_BUDGET_PROGRAM,
  MEMO_PROGRAM,
  TOKEN_PROGRAM,
  validateExactPaymentTransaction,
  type ExpectedExactPayment,
} from "./transaction-validator.js";

// Hand-built transactions, independent of ExactSvmScheme, exercising the
// pre-transmission validator directly.

const BLOCKHASH = "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace1111";
const OTHER_BLOCKHASH = "SURFNETxSAFEHASHxxxxxxxxxxxxxxxxxxx1ace2222";

const payer = await generateKeyPairSigner();
const facilitator = (await generateKeyPairSigner()).address;
const mint = (await generateKeyPairSigner()).address;
const otherMint = (await generateKeyPairSigner()).address;
const payTo = (await generateKeyPairSigner()).address;
const attacker = (await generateKeyPairSigner()).address;

const expected: ExpectedExactPayment = {
  payer: payer.address,
  feePayer: facilitator,
  asset: mint,
  payTo,
  amountAtomic: "10000",
  blockhash: BLOCKHASH,
};

function u64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
}

async function transferChecked(options: {
  amount?: bigint;
  mint?: Address;
  destinationOwner?: Address;
  sourceOwner?: Address;
  authority?: KeyPairSigner;
  discriminator?: number;
}): Promise<Instruction> {
  const tokenMint = options.mint ?? mint;
  const authority = options.authority ?? payer;
  return {
    programAddress: address(TOKEN_PROGRAM),
    accounts: [
      { address: address(await associatedTokenAddress(options.sourceOwner ?? payer.address, tokenMint, TOKEN_PROGRAM)), role: AccountRole.WRITABLE },
      { address: tokenMint, role: AccountRole.READONLY },
      { address: address(await associatedTokenAddress(options.destinationOwner ?? payTo, tokenMint, TOKEN_PROGRAM)), role: AccountRole.WRITABLE },
      { address: authority.address, role: AccountRole.READONLY_SIGNER, signer: authority },
    ],
    data: new Uint8Array([options.discriminator ?? 12, ...u64(options.amount ?? 10000n), 6]),
  } as Instruction;
}

const computeLimit: Instruction = { programAddress: address(COMPUTE_BUDGET_PROGRAM), data: new Uint8Array([2, 0x20, 0x4e, 0, 0]) };
const computePrice: Instruction = { programAddress: address(COMPUTE_BUDGET_PROGRAM), data: new Uint8Array([3, ...u64(1n)]) };
const memo: Instruction = { programAddress: address(MEMO_PROGRAM), data: new TextEncoder().encode("nonce-1234") };

async function build(
  instructions: Instruction[],
  options: { feePayer?: Address; blockhash?: string; version?: 0 | "legacy" } = {},
): Promise<string> {
  const message = pipe(
    createTransactionMessage({ version: options.version ?? 0 }),
    (tx) => setTransactionMessageFeePayer(options.feePayer ?? facilitator, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(options.blockhash ?? BLOCKHASH), lastValidBlockHeight: 1000n }, tx),
    (tx) => appendTransactionMessageInstructions(instructions, tx),
  );
  return getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message));
}

async function expectRejected(transaction: unknown, pattern: RegExp, overrides: Partial<ExpectedExactPayment> = {}): Promise<void> {
  const result = await validateExactPaymentTransaction(transaction, { ...expected, ...overrides });
  assert.equal(result.valid, false);
  assert.match(result.valid ? "" : result.reason, pattern);
}

test("accepts exactly the authorized payment and returns the payer's signature", async () => {
  const transaction = await build([computeLimit, computePrice, await transferChecked({}), memo]);
  const result = await validateExactPaymentTransaction(transaction, expected);

  assert.equal(result.valid, true);
  const decoded = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const signature = decoded.signatures[payer.address as keyof typeof decoded.signatures];
  assert.equal(result.valid && result.payerSignature, getBase58Decoder().decode(signature as Uint8Array));
});

test("rejects a wrong mint", async () => {
  await expectRejected(await build([await transferChecked({ mint: otherMint })]), /mint/);
});

test("rejects a wrong destination / payTo token account", async () => {
  await expectRejected(await build([await transferChecked({ destinationOwner: attacker })]), /destination/);
});

test("rejects a wrong source token account", async () => {
  await expectRejected(await build([await transferChecked({ sourceOwner: attacker })]), /source/);
});

test("rejects a wrong amount (lower or higher)", async () => {
  await expectRejected(await build([await transferChecked({ amount: 10001n })]), /amount/);
  await expectRejected(await build([await transferChecked({ amount: 1n })]), /amount/);
});

test("rejects a blockhash other than the authority-fetched one", async () => {
  await expectRejected(await build([await transferChecked({})], { blockhash: OTHER_BLOCKHASH }), /blockhash/);
});

test("rejects an additional token transfer", async () => {
  const second = await transferChecked({ destinationOwner: attacker, amount: 1n });
  await expectRejected(await build([await transferChecked({}), second]), /more than one token instruction/);
});

test("rejects token instructions other than a single TransferChecked", async () => {
  // Legacy Transfer (3) and Approve (4) instead of TransferChecked.
  await expectRejected(await build([await transferChecked({ discriminator: 3 })]), /not TransferChecked/);
  await expectRejected(await build([await transferChecked({ discriminator: 4 })]), /not TransferChecked/);
  await expectRejected(await build([await transferChecked({}), await transferChecked({ discriminator: 4 })]), /more than one token instruction/);
  await expectRejected(await build([computeLimit, memo]), /no token transfer|signers/);
});

test("rejects other value-moving or account-touching instructions", async () => {
  const systemTransfer = {
    programAddress: address("11111111111111111111111111111111"),
    accounts: [
      { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer },
      { address: attacker, role: AccountRole.WRITABLE },
    ],
    data: new Uint8Array([2, 0, 0, 0, ...u64(1_000_000n)]),
  } as Instruction;
  await expectRejected(await build([await transferChecked({}), systemTransfer]), /unexpected program/);

  const memoWithAccount = { ...memo, accounts: [{ address: attacker, role: AccountRole.WRITABLE }] } as Instruction;
  await expectRejected(await build([await transferChecked({}), memoWithAccount]), /memo/);

  const heapFrame: Instruction = { programAddress: address(COMPUTE_BUDGET_PROGRAM), data: new Uint8Array([1, 0, 0, 1, 0]) };
  await expectRejected(await build([heapFrame, await transferChecked({})]), /compute-budget/);
});

test("rejects the payment wallet as fee payer", async () => {
  // Expected facts that would make the payer the fee payer.
  await expectRejected(await build([await transferChecked({})]), /must not be the fee payer/, { feePayer: payer.address });
  // A transaction that makes the payer pay fees instead of the facilitator.
  await expectRejected(await build([await transferChecked({})], { feePayer: payer.address }), /fee payer/);
});

test("rejects extra signers", async () => {
  const extraSigner = await generateKeyPairSigner();
  const extra = await transferChecked({ authority: extraSigner });
  await expectRejected(await build([extra]), /signers|authority/);
});

test("rejects unsupported transaction structures", async () => {
  await expectRejected(await build([await transferChecked({})], { version: "legacy" }), /version/);

  const destination = address(await associatedTokenAddress(payTo, mint, TOKEN_PROGRAM));
  const withLookup = compressTransactionMessageUsingAddressLookupTables(
    pipe(
      createTransactionMessage({ version: 0 }),
      (tx) => setTransactionMessageFeePayer(facilitator, tx),
      (tx) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: toBlockhash(BLOCKHASH), lastValidBlockHeight: 1000n }, tx),
      (tx) => appendTransactionMessageInstructions([{ programAddress: address(MEMO_PROGRAM), accounts: [{ address: destination, role: AccountRole.READONLY }], data: new Uint8Array([1]) } as Instruction], tx),
    ),
    { [address((await generateKeyPairSigner()).address)]: [destination] },
  );
  await expectRejected(getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(withLookup)), /lookup tables/);
});

test("fails closed on malformed input without throwing", async () => {
  const malformed: unknown[] = [
    undefined,
    null,
    42,
    "",
    "not base64 !!",
    Buffer.from(randomBytes(3)).toString("base64"),
    Buffer.from(randomBytes(300)).toString("base64"),
    (await build([await transferChecked({})])).slice(0, 60),
  ];

  for (const candidate of malformed) {
    const result = await validateExactPaymentTransaction(candidate, expected);
    assert.equal(result.valid, false, String(candidate).slice(0, 20));
  }

  await expectRejected(await build([await transferChecked({})]), /canonical/, { amountAtomic: "1.5" });
});
