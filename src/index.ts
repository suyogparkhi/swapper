#! /usr/bin/env bun

import {
    BitcoinWallet,
    BitcoinProvider,
    BitcoinNetwork,
    EVMWallet,
} from "@catalogfi/wallets";
import { JsonRpcProvider, Wallet } from "ethers";
import {
    Assets,
    parseStatus,
    Actions,
    type Asset,
    type Order,
} from "@gardenfi/orderbook";

import { writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

import { ivar, ccreator } from "./command.ts";
import {
    getEVMWallet,
    getGarden,
    readJsonFileSync,
    logAddressAndBalance,
    getBitcoinWallet,
} from "./utility.ts";
import { KeyError, WalletError, AmountError } from "./errors.ts";
import { sleep } from "bun";

if (!existsSync(join(homedir(), ".swapper_api_key"))) {
    throw new Error(
        "API_KEY not found, try running ./setup_key.sh <API_KEY> in the swapper dir",
    );
}

// Constants
const API_KEY = readFileSync(join(homedir(), ".swapper_api_key"), "utf-8");
const RPC_PROVIDER_URL = `https://sepolia.gateway.tenderly.co/${API_KEY}`;
const ETHEREUM_PROVIDER = new JsonRpcProvider(RPC_PROVIDER_URL);
const BITCOIN_PROVIDER = new BitcoinProvider(BitcoinNetwork.Testnet);
const DOT_CONFIG_PATH = join(homedir(), ".swapper_config.json");

// Read config
let dotConfig = readJsonFileSync(DOT_CONFIG_PATH);

// Command Definitions
ccreator.command("createevmwallet", "creates a evm wallet", async () => {
    const { privatekey: privateKey } = ivar;

    if (!privateKey) throw new KeyError();

    const wallet = new Wallet(privateKey, ETHEREUM_PROVIDER);
    const evmWallet = new EVMWallet(wallet);

    const address = await evmWallet.getAddress();
    const balance = await evmWallet.getProvider().getBalance(address);

    logAddressAndBalance(address, balance);

    dotConfig.evmPrivateKey = privateKey;
    writeFileSync(DOT_CONFIG_PATH, JSON.stringify(dotConfig));

    console.info(`Saved to ${DOT_CONFIG_PATH}`);
});

ccreator.command(
    "createbitcoinwallet",
    "creates a bitcoin wallet",
    async () => {
        const { privatekey: privateKey } = ivar;

        if (!privateKey) throw new KeyError();

        const bitcoinWallet = BitcoinWallet.fromWIF(
            privateKey,
            BITCOIN_PROVIDER,
        );
        const address = await bitcoinWallet.getAddress();
        const balance = await bitcoinWallet.getBalance();

        logAddressAndBalance(address, balance);

        dotConfig.bitcoinPrivateKey = privateKey;
        writeFileSync(DOT_CONFIG_PATH, JSON.stringify(dotConfig));

        console.info(`Saved to ${DOT_CONFIG_PATH}`);
    },
);

ccreator.command(
    "getdetails",
    "gets the contents of $HOME/.swapper_config.json",
    () => {
        console.info(readJsonFileSync(DOT_CONFIG_PATH));
    },
);

async function swap(fromAsset: Asset, toAsset: Asset, amount: number) {
    const { bitcoinPrivateKey, evmPrivateKey } = dotConfig;
    if (!bitcoinPrivateKey || !evmPrivateKey) throw new WalletError();

    const evmWallet = getEVMWallet(evmPrivateKey, ETHEREUM_PROVIDER);
    const bitcoinWallet = getBitcoinWallet(bitcoinPrivateKey, BITCOIN_PROVIDER);
    const garden = await getGarden(evmPrivateKey, evmWallet, bitcoinWallet);

    const sendAmount = amount * 1e8;
    const recieveAmount = (1 - 0.3 / 100) * sendAmount;

    const orderId = await garden.swap(
        fromAsset,
        toAsset,
        sendAmount,
        recieveAmount,
    );

    let order: Order | null = null;

    garden.subscribeOrders(await evmWallet.getAddress(), (orders) => {
        order = orders.filter((order) => order.ID === orderId)[0];
    });

    let prevAction = null;
    while (true) {
        await sleep(500); // Time for `subscribeOrders` to update the state of orders
        if (!order) continue;
        const action = parseStatus(order);
        if (
            (action === Actions.UserCanInitiate ||
                action === Actions.UserCanRedeem) &&
            prevAction !== action
        ) {
            const swapper = garden.getSwap(order);
            const performedAction = await swapper.next();
            console.info(
                `Completed Action ${performedAction.action} with transaction hash: ${performedAction.output}`,
            );
        }

        if (action === Actions.UserCanRedeem) {
            garden.unsubscribeOrders();
            break;
        }
        prevAction = action;
    }
}

ccreator.command("swapwbtctobtc", "Swaps from WBTC to BTC", async () => {
    console.info("Processing please wait..");
    const { amount } = ivar;
    if (!amount) throw new AmountError();
    await swap(
        Assets.ethereum_sepolia.WBTC,
        Assets.bitcoin_testnet.BTC,
        amount,
    );
});

ccreator.command("swapbtctowbtc", "Swaps from BTC to WBTC", async () => {
    console.info("Processing please wait..");
    const { amount } = ivar;
    if (!amount) throw new AmountError();
    await swap(
        Assets.bitcoin_testnet.BTC,
        Assets.ethereum_sepolia.WBTC,
        amount,
    );
});

ccreator.command("checkbalances", "Displays BTC and WBTC wallet balances", async () => {
    const { bitcoinPrivateKey, evmPrivateKey } = dotConfig;
    if (!bitcoinPrivateKey || !evmPrivateKey) throw new WalletError();

    const evmWallet = getEVMWallet(evmPrivateKey, ETHEREUM_PROVIDER);
    const bitcoinWallet = getBitcoinWallet(bitcoinPrivateKey, BITCOIN_PROVIDER);

    const evmAddress = await evmWallet.getAddress();
    const evmBalance = await evmWallet.getProvider().getBalance(evmAddress);
    console.info(`EVM Wallet Address: ${evmAddress}`);
    console.info(`EVM Wallet Balance (in Wei): ${evmBalance.toString()}`);

    const bitcoinAddress = await bitcoinWallet.getAddress();
    const bitcoinBalance = await bitcoinWallet.getBalance();
    console.info(`Bitcoin Wallet Address: ${bitcoinAddress}`);
    console.info(`Bitcoin Wallet Balance (in Satoshis): ${bitcoinBalance}`);
});

ccreator.command("rebalance", "Rebalances the portfolio by swapping assets", async () => {
    const { amount, from, to } = ivar;
    if (!amount || !from || !to) throw new AmountError("Amount, from, or to asset not specified");

    let fromAsset: Asset, toAsset: Asset;
    if (from.toUpperCase() === "BTC" && to.toUpperCase() === "WBTC") {
        fromAsset = Assets.bitcoin_testnet.BTC;
        toAsset = Assets.ethereum_sepolia.WBTC;
    } else if (from.toUpperCase() === "WBTC" && to.toUpperCase() === "BTC") {
        fromAsset = Assets.ethereum_sepolia.WBTC;
        toAsset = Assets.bitcoin_testnet.BTC;
    } else {
        throw new Error("Invalid assets specified for swap. Valid options are BTC and WBTC.");
    }

    console.info("Rebalancing portfolio, please wait...");
    await swap(fromAsset, toAsset, amount);
    console.info("Portfolio rebalanced successfully!");
});


ccreator.parse();
