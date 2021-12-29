/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import 'core-js/stable';
import 'regenerator-runtime/runtime';
import path from 'path';
import { app, BrowserWindow, shell, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import * as sol from '@solana/web3.js';
import os from 'os';
import fs from 'fs';
import util from 'util';
import { exec } from 'child_process';
import winston from 'winston';
import randomart from 'randomart';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import sqlite3 from 'sqlite3';
import { Database, open } from 'sqlite';
import logfmt from 'logfmt';
import MenuBuilder from './menu';
import { resolveHtmlPath } from './util';
import {
  WBAccount,
  AccountsResponse,
  Net,
  SolState,
  GetAccountResponse,
  ValidatorLogsRequest,
  AccountsRequest,
  ImportAccountRequest,
  GetAccountRequest,
} from '../types/types';

const execAsync = util.promisify(exec);
const WORKBENCH_VERSION = '0.1.3-dev';
const WORKBENCH_DIR_NAME = '.solana-workbench';
const WORKBENCH_DIR_PATH = path.join(os.homedir(), WORKBENCH_DIR_NAME);
const KEYPAIR_DIR_PATH = path.join(WORKBENCH_DIR_PATH, 'keys');
const LOG_DIR_PATH = path.join(WORKBENCH_DIR_PATH, 'logs');
const LOG_FILE_PATH = path.join(LOG_DIR_PATH, 'latest.log');
const KEY_FILE_NAME = 'wbkey.json';
const KEY_PATH = path.join(KEYPAIR_DIR_PATH, KEY_FILE_NAME);
const MIGRATION_DIR = 'assets/migrations';
const DB_PATH = path.join(WORKBENCH_DIR_PATH, 'wb.db');
const MAX_LOG_FILE_BYTES = 5 * 1028 * 1028;
const DOCKER_IMAGE =
  process.arch === 'arm64'
    ? 'nathanleclaire/solana:v1.9.2'
    : 'solanalabs/solana:v1.9.2';
let DOCKER_PATH = 'docker';
const AIRDROP_AMOUNT = 100;
if (process.platform !== 'win32') {
  DOCKER_PATH = '/usr/local/bin/docker';
}
if (!fs.existsSync(WORKBENCH_DIR_PATH)) {
  fs.mkdirSync(WORKBENCH_DIR_PATH);
}
if (!fs.existsSync(KEYPAIR_DIR_PATH)) {
  fs.mkdirSync(KEYPAIR_DIR_PATH);
}
if (!fs.existsSync(LOG_DIR_PATH)) {
  fs.mkdirSync(LOG_DIR_PATH);
}

let db: Database<sqlite3.Database, sqlite3.Statement>;
let logger = winston.createLogger({
  transports: [new winston.transports.Console()],
});

const initLogging = async () => {
  // todo: could do better log rotation,
  // but this will do for now to avoid infinite growth
  try {
    const stat = await fs.promises.stat(LOG_FILE_PATH);
    if (stat.size > MAX_LOG_FILE_BYTES) {
      await fs.promises.rm(LOG_FILE_PATH);
    }
    // might get exception if file does not exist,
    // but it's expected.
    //
    // eslint-disable-next-line no-empty
  } catch (error) {}

  const logfmtFormat = winston.format.printf((info) => {
    const { timestamp } = info.metadata;
    delete info.metadata.timestamp;
    return `${timestamp} ${info.level.toUpperCase()} ${
      info.message
    } \t${logfmt.stringify(info.metadata)}`;
  });
  logger = winston.createLogger({
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.metadata(),
      logfmtFormat
    ),
    transports: [
      new winston.transports.File({
        filename: LOG_FILE_PATH,
        handleExceptions: true,
      }),
    ],
  });

  logger.info('Workbench session begin', {
    version: WORKBENCH_VERSION,
    workdir: process.cwd(),
  });
};
initLogging();

const initDB = async () => {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  await db.migrate({
    table: 'migration',
    migrationsPath: MIGRATION_DIR,
  });
};
initDB();

const netToURL = (net: Net): string => {
  switch (net) {
    case Net.Localhost:
      return 'http://127.0.0.1:8899';
    case Net.Dev:
      return 'https://api.devnet.solana.com';
    case Net.Test:
      return 'https://api.testnet.solana.com';
    case Net.MainnetBeta:
      return 'https://api.mainnet-beta.solana.com';
    default:
  }
  return '';
};

const connectSOL = async (net: Net): Promise<SolState> => {
  let solConn: sol.Connection;

  // Connect to cluster
  const ret = {
    running: false,
    keyId: '',
  } as SolState;
  try {
    solConn = new sol.Connection(netToURL(net));
    await solConn.getEpochInfo();
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ECONNREFUSED') {
      return ret;
    }
  }
  ret.running = true;
  return ret;
};

const localKeypair = async (f: string): Promise<sol.Keypair> => {
  const fileContents = await fs.promises.readFile(f);
  const data = Uint8Array.from(JSON.parse(fileContents.toString()));
  return sol.Keypair.fromSecretKey(data);
};

async function getAccount(
  net: Net,
  pubKey: string
): Promise<GetAccountResponse> {
  const solConn = new sol.Connection(netToURL(net));
  const resp: GetAccountResponse = {};
  try {
    const key = new sol.PublicKey(pubKey);
    const art = randomart(key.toBytes());
    const solAccount = await solConn.getAccountInfo(key);
    const solAmount = solAccount?.lamports;
    if (solAccount !== null) {
      resp.account = { pubKey, solAmount, art, solAccount };
    } else {
      resp.account = { pubKey };
    }
  } catch (e) {
    resp.err = e as Error;
  }
  return resp;
}

async function accounts(net: Net): Promise<AccountsResponse> {
  const kp = await localKeypair(KEY_PATH);
  logger.info(net);
  const solConn = new sol.Connection(netToURL(net));
  const existingAccounts = await db.all('SELECT * FROM account');
  logger.info('existingAccounts', { existingAccounts });
  if (existingAccounts?.length > 0) {
    const pubKeys = existingAccounts.map((a) => new sol.PublicKey(a.pubKey));
    const solAccountInfo = await solConn.getMultipleAccountsInfo(pubKeys);
    const mergedAccountInfo: WBAccount[] = solAccountInfo.map(
      (a: sol.AccountInfo<Buffer> | null, i: number) => {
        const newAcc = Object.assign(existingAccounts[i], a);
        const key = new sol.PublicKey(existingAccounts[i].pubKey);
        newAcc.art = randomart(key.toBytes());
        newAcc.sol = newAcc.lamports / sol.LAMPORTS_PER_SOL;
        return newAcc;
      }
    );
    return {
      rootKey: kp.publicKey.toString(),
      accounts: mergedAccountInfo,
    };
  }

  const N_ACCOUNTS = 5;
  const txn = new sol.Transaction();
  const createdAccounts: sol.Keypair[] = [];
  for (let i = 0; i < N_ACCOUNTS; i += 1) {
    const acc = new sol.Keypair();
    txn.add(
      sol.SystemProgram.createAccount({
        fromPubkey: kp.publicKey,
        newAccountPubkey: acc.publicKey,
        space: 0,
        lamports: 10 * sol.LAMPORTS_PER_SOL,
        programId: sol.SystemProgram.programId,
      })
    );
    logger.info('adding account', {
      acc_pubkey: acc.publicKey,
    });

    createdAccounts.push(acc);
    db.exec('');
  }

  const txnID = await sol.sendAndConfirmTransaction(
    solConn,
    txn,
    [kp, createdAccounts].flat()
  );

  logger.info('created accounts', { txnID });

  const stmt = await db.prepare(
    'INSERT INTO account (pubKey, netID, humanName) VALUES (?, ?, ?)'
  );
  createdAccounts.forEach(async (acc, i) => {
    await stmt.run([acc.publicKey.toString(), Net.Localhost, `Wallet ${i}`]);
  });
  await stmt.finalize();

  return {
    rootKey: kp.publicKey.toString(),
    // todo: this should be on created accounts from DB
    accounts: createdAccounts.map((acc) => {
      return {
        art: randomart(acc.publicKey.toBytes()),
        pubKey: acc.publicKey.toString(),
        humanName: '',
      };
    }),
  };
}

async function updateAccountName(pubKey: string, humanName: string) {
  const res = await db.run(
    'UPDATE account SET humanName = ? WHERE pubKey = ?',
    humanName,
    pubKey
  );
  return res;
}

async function importAccount(pubKey: string, net: string) {
  const res = await db.run(
    'INSERT INTO account VALUES (pubKey, net) (?, ?)',
    pubKey,
    net
  );
  return res;
}

const addKeypair = async (net: Net, kpPath: string) => {
  const kp = sol.Keypair.generate();
  const solConn = new sol.Connection(netToURL(net));

  // todo: this conn might not be initialized yet
  await solConn.confirmTransaction(
    await solConn.requestAirdrop(
      kp.publicKey,
      AIRDROP_AMOUNT * sol.LAMPORTS_PER_SOL
    )
  );

  // goofy looking but otherwise stringify encodes Uint8Array like:
  // {"0": 1, "1": 2, "2": 3 ...}
  const secretKeyUint = Array.from(Uint8Array.from(kp.secretKey));
  const fileContents = JSON.stringify(secretKeyUint);
  await fs.promises.writeFile(kpPath, fileContents);
};

const runValidator = async () => {
  try {
    await execAsync(`${DOCKER_PATH} inspect solana-test-validator`);
  } catch (e) {
    // TODO: check for image, pull if not present
    await execAsync(
      `${DOCKER_PATH} run \
        --name solana-test-validator \
        -d \
        --init \
        -p 8899:8899 \
        -p 8900:8900 \
        --log-driver local \
        --ulimit nofile=1000000 \
        ${DOCKER_IMAGE} \
        solana-test-validator \
        --limit-ledger-size 50000000`
    );

    return;
  }
  await execAsync(`${DOCKER_PATH} start solana-test-validator`);
};

const validatorLogs = async (filter: string) => {
  const MAX_TAIL_LINES = 10000;
  const MAX_DISPLAY_LINES = 30;

  // TODO: doing this out of process might be a better fit
  const maxBuffer = 104857600; // 100MB

  if (filter !== '') {
    const { stderr } = await execAsync(
      `${DOCKER_PATH} logs --tail ${MAX_TAIL_LINES} solana-test-validator`,
      { maxBuffer }
    );
    const lines = stderr.split('\n').filter((s) => s.match(filter));
    const matchingLines = lines
      .slice(Math.max(lines.length - MAX_DISPLAY_LINES, 0))
      .join('\n');
    logger.info('Filtered log lookup', {
      matchLinesLen: matchingLines.length,
      filterLinesLen: lines.length,
    });
    return matchingLines;
  }
  const { stderr } = await execAsync(
    `${DOCKER_PATH} logs --tail ${MAX_DISPLAY_LINES} solana-test-validator`,
    { maxBuffer }
  );
  return stderr;
};

export default class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
const ipcMiddleware = (
  channel: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (event: Electron.IpcMainEvent, ...args: any[]) => void
) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (event: Electron.IpcMainEvent, ...args: any[]) => {
    logger.info('IPC event', Object.assign({ channel }, ...args));
    try {
      await fn(event, ...args);
    } catch (e) {
      const error = e as Error;
      const { stack } = error;
      logger.error('IPC error', {
        channel,
        name: error.name,
      });
      logger.error('Stacktrace:');
      stack?.split('\n').forEach((line) => logger.error(`\t${line}`));
    }
  };
};

ipcMain.on(
  'sol-state',
  ipcMiddleware('sol-state', async (event: Electron.IpcMainEvent, msg) => {
    const solState = await connectSOL(msg.net);
    event.reply('sol-state', solState);
  })
);

ipcMain.on(
  'run-validator',
  ipcMiddleware('run-validator', async (event: Electron.IpcMainEvent) => {
    runValidator();
    event.reply('run-validator', {});
  })
);

ipcMain.on(
  'validator-logs',
  ipcMiddleware(
    'validator-logs',
    async (event: Electron.IpcMainEvent, msg: ValidatorLogsRequest) => {
      const logs = await validatorLogs(msg.filter);
      event.reply('validator-logs', logs);
    }
  )
);

ipcMain.on(
  'get-account',
  ipcMiddleware(
    'get-account',
    async (event: Electron.IpcMainEvent, msg: GetAccountRequest) => {
      const account = await getAccount(msg.net, msg.pk);
      event.reply('get-account', account);
    }
  )
);

ipcMain.on(
  'accounts',
  ipcMiddleware(
    'accounts',
    async (event: Electron.IpcMainEvent, msg: AccountsRequest) => {
      try {
        await fs.promises.access(KEY_PATH);
      } catch {
        logger.info('Creating root key', { KEY_PATH });
        await addKeypair(msg.net, KEY_PATH);
      }
      const pairs = await accounts(msg.net);
      event.reply('accounts', pairs);
    }
  )
);

ipcMain.on(
  'update-account-name',
  ipcMiddleware(
    'update-account-name',
    async (event: Electron.IpcMainEvent, msg) => {
      event.reply(
        'update-account-name',
        await updateAccountName(msg.pubKey, msg.humanName)
      );
    }
  )
);

ipcMain.on(
  'import-account',
  ipcMiddleware(
    'import-account',
    async (event: Electron.IpcMainEvent, msg: ImportAccountRequest) => {
      event.reply('import-account', await importAccount(msg.net, msg.pubKey));
    }
  )
);

ipcMain.on(
  'add-keypair',
  ipcMiddleware('add-keypair', async (event: Electron.IpcMainEvent, msg) => {
    // should be able to create more keypairs than just wbkey.json
    await addKeypair(Net.Localhost, 'fixme');
    const pairs = await accounts(msg.net);
    event.reply('add-keypair', pairs);
  })
);

ipcMain.on(
  'airdrop',
  ipcMiddleware('airdrop', async (event: Electron.IpcMainEvent) => {
    event.reply('airdrop success');
  })
);

ipcMain.on(
  'fetch-anchor-idl',
  ipcMiddleware(
    'fetch-anchor-idl',
    async (event: Electron.IpcMainEvent, msg) => {
      const { stdout } = await execAsync(`anchor idl fetch ${msg.programID}`);
      event.reply('fetch-anchor-idl', JSON.parse(stdout));
    }
  )
);

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDevelopment =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDevelopment) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDevelopment) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.on('new-window', (event, url) => {
    event.preventDefault();
    shell.openExternal(url);
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */

app.on('window-all-closed', () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  db.close();

  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
