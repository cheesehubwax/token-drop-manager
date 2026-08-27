/**
 * Client-only wallet wrapper around WharfKit SessionKit.
 * This module must only be imported dynamically after hydration (SSR-unsafe).
 */
import { SessionKit, Session, Chains, type ChainDefinition } from "@wharfkit/session";
import { WebRenderer } from "@wharfkit/web-renderer";
import { WalletPluginAnchor } from "@wharfkit/wallet-plugin-anchor";
import { WalletPluginCloudWallet } from "@wharfkit/wallet-plugin-cloudwallet";
import { CHEESE_CONTRACT } from "./cheese";

export const WAX_CHAIN: ChainDefinition = Chains.WAX;

const CHAIN_URL = "https://wax.greymass.com";

let kit: SessionKit | null = null;

function getKit(): SessionKit {
  if (!kit) {
    kit = new SessionKit({
      appName: "WAX Airdrop Tool",
      chains: [{ ...WAX_CHAIN, url: CHAIN_URL }],
      ui: new WebRenderer(),
      walletPlugins: [new WalletPluginCloudWallet(), new WalletPluginAnchor()],
    });
  }
  return kit;
}

export async function loginWallet(): Promise<Session> {
  const response = await getKit().login();
  return response.session;
}

export async function restoreWallet(): Promise<Session | null> {
  try {
    return (await getKit().restore()) ?? null;
  } catch {
    return null;
  }
}

export async function logoutWallet(session: Session): Promise<void> {
  try {
    await getKit().logout(session);
  } catch {
    // best effort
  }
}

export interface TransferActionInput {
  tokenContract: string;
  from: string;
  to: string;
  quantity: string;
  memo: string;
}

/** Sign and broadcast a batch of transfer actions. Returns the transaction id. */
export async function transactTransfers(
  session: Session,
  transfers: TransferActionInput[],
): Promise<string> {
  const actions = transfers.map((t) => ({
    account: t.tokenContract,
    name: "transfer",
    authorization: [{ actor: session.actor.toString(), permission: session.permission.toString() }],
    data: {
      from: t.from,
      to: t.to,
      quantity: t.quantity,
      memo: t.memo,
    },
  }));
  const result = await session.transact({ actions });
  const txId = result.response?.["transaction_id"];
  if (typeof txId === "string" && txId) return txId;
  return result.request.toString();
}

export interface CheeseTransferInput {
  /** Destination contract: cheesepowerz (CPU/NET) or ram.chz (RAM). */
  to: string;
  /** Formatted CHEESE quantity, e.g. "2.5000 CHEESE". */
  quantity: string;
  memo: string;
}

/** Sign and broadcast a single CHEESE transfer (resource purchase). */
export async function transferCheese(
  session: Session,
  input: CheeseTransferInput,
): Promise<string> {
  const result = await session.transact({
    actions: [
      {
        account: CHEESE_CONTRACT,
        name: "transfer",
        authorization: [
          { actor: session.actor.toString(), permission: session.permission.toString() },
        ],
        data: {
          from: session.actor.toString(),
          to: input.to,
          quantity: input.quantity,
          memo: input.memo,
        },
      },
    ],
  });
  const txId = result.response?.["transaction_id"];
  if (typeof txId === "string" && txId) return txId;
  return result.request.toString();
}
