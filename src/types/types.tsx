import * as sol from '@solana/web3.js';

export interface SolState {
  installed: boolean;
  running: boolean;
  keyId: string;
}

export enum Net {
  Localhost = 'localhost',
  Dev = 'dev',
  Test = 'test',
  MainnetBeta = 'mainnet-beta',
}

export type WBAccount = {
  pubKey: string;
  humanName?: string;
  art?: string;
  solAmount?: number;
  hexDump?: string;
  solAccount?: sol.AccountInfo<Buffer> | null;
};

export type SolStateRequest = {
  net: Net;
};

export type ValidatorLogsRequest = {
  filter: string;
};

export type GetAccountRequest = {
  net: Net;
  pk: string;
};

export type AccountsRequest = {
  net: Net;
};

export type UpdateAccountRequest = {
  pubKey: string;
  humanName: string;
};

export type ImportAccountRequest = {
  net: Net;
  pubKey: string;
};

export type AccountsResponse = {
  rootKey: string;
  accounts: WBAccount[];
};

export type GetAccountResponse = {
  account?: WBAccount | null;
  err?: Error;
};
