import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomInt } from "node:crypto";
import path from "node:path";

import { CONFIG_PATH } from "@/utils/utils";

const PAIRING_FILE_PATH = path.join(CONFIG_PATH, "pairing.json");

type PendingPairing = {
  sessionKey: string;
  code: string;
  createdAt: string;
};

type PairingStore = {
  pairedSessionKeys: string[];
  pendingPairings: PendingPairing[];
};

type PairingState = {
  code: string;
  isNew: boolean;
};

type PairingApprovalResult =
  | {
      ok: true;
      sessionKey: string;
    }
  | {
      ok: false;
    };

const DEFAULT_STORE: PairingStore = {
  pairedSessionKeys: [],
  pendingPairings: []
};

export function isSessionPaired(sessionKey: string): boolean {
  const store = loadPairingStore();
  return store.pairedSessionKeys.includes(sessionKey);
}

export function ensurePairingCode(sessionKey: string): PairingState {
  const store = loadPairingStore();

  if (store.pairedSessionKeys.includes(sessionKey)) {
    return {
      code: "",
      isNew: false
    };
  }

  const existingPairing = store.pendingPairings.find((pairing) => pairing.sessionKey === sessionKey);
  if (existingPairing) {
    return {
      code: existingPairing.code,
      isNew: false
    };
  }

  const code = generateUniqueCode(store.pendingPairings);
  store.pendingPairings.push({
    sessionKey,
    code,
    createdAt: new Date().toISOString()
  });
  savePairingStore(store);

  return {
    code,
    isNew: true
  };
}

export function approvePairingCode(code: string): PairingApprovalResult {
  const normalizedCode = normalizePairingCode(code);
  const store = loadPairingStore();
  const pendingPairing = store.pendingPairings.find((pairing) => pairing.code === normalizedCode);

  if (!pendingPairing) {
    return { ok: false };
  }

  if (!store.pairedSessionKeys.includes(pendingPairing.sessionKey)) {
    store.pairedSessionKeys.push(pendingPairing.sessionKey);
  }

  store.pendingPairings = store.pendingPairings.filter(
    (pairing) => pairing.sessionKey !== pendingPairing.sessionKey
  );
  savePairingStore(store);

  return {
    ok: true,
    sessionKey: pendingPairing.sessionKey
  };
}

function loadPairingStore(): PairingStore {
  if (!existsSync(PAIRING_FILE_PATH)) {
    return structuredClone(DEFAULT_STORE);
  }

  const rawStore = readFileSync(PAIRING_FILE_PATH, "utf8").trim();
  if (rawStore === "") {
    return structuredClone(DEFAULT_STORE);
  }

  const parsed = JSON.parse(rawStore) as Partial<PairingStore>;
  return {
    pairedSessionKeys: Array.isArray(parsed.pairedSessionKeys)
      ? parsed.pairedSessionKeys.filter((value): value is string => typeof value === "string")
      : [],
    pendingPairings: Array.isArray(parsed.pendingPairings)
      ? parsed.pendingPairings.filter(isPendingPairing)
      : []
  };
}

function savePairingStore(store: PairingStore): void {
  writeFileSync(PAIRING_FILE_PATH, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function isPendingPairing(value: unknown): value is PendingPairing {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.sessionKey === "string" &&
    typeof candidate.code === "string" &&
    typeof candidate.createdAt === "string"
  );
}

function generateUniqueCode(pendingPairings: PendingPairing[]): string {
  const existingCodes = new Set(pendingPairings.map((pairing) => pairing.code));

  while (true) {
    const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
    if (!existingCodes.has(code)) {
      return code;
    }
  }
}

function normalizePairingCode(code: string): string {
  const normalizedCode = code.trim();

  if (!/^\d{6}$/.test(normalizedCode)) {
    throw new Error("Pairing code must be exactly 6 digits.");
  }

  return normalizedCode;
}
