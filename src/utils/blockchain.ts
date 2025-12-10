import { ethers } from "ethers";

const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
];

const ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

export interface ConversionResult {
    inputAmount: string;
    outputAmount: string;
    conversionRate: string;
}

/**
 * Get transaction fee for a given transaction hash
 * @param txHash - The transaction hash
 * @returns Object containing total fee in ETH
 */
export async function getTxFee(txHash: string) {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    const [tx, receipt] = await Promise.all([
        provider.getTransaction(txHash),
        provider.getTransactionReceipt(txHash),
    ]);

    if (!tx || !receipt) {
        throw new Error("Transaction or receipt not found");
    }

    const gasUsed = receipt.gasUsed;
    const effectiveGasPrice = receipt.gasPrice ?? tx.gasPrice ?? 0n;
    const totalFee = gasUsed * effectiveGasPrice;

    return {
        totalFeeETH: ethers.formatEther(totalFee),
    };
}

/**
 * Get conversion rate from an Arbitrum transaction
 * @param userAddress - The user's wallet address
 * @param txHash - The transaction hash
 * @returns Object containing inputAmount, outputAmount, and conversionRate
 */
export async function getConversionRate(
    userAddress: string,
    txHash: string
): Promise<ConversionResult> {
    const provider = new ethers.JsonRpcProvider(ARBITRUM_RPC);

    const receipt = await provider.getTransactionReceipt(txHash);

    if (!receipt) {
        throw new Error("Transaction not found");
    }

    // ERC20 Transfer event signature
    const transferTopic =
        "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

    let inputToken: { address: string; amount: string } | null = null;
    let outputToken: { address: string; amount: string } | null = null;

    for (const log of receipt.logs) {
        if (log.topics.length >= 3 && log.topics[0] === transferTopic) {
            const from = `0x${log.topics[1]!.slice(26)}`;
            const to = `0x${log.topics[2]!.slice(26)}`;
            const amount = log.data; // hex string

            // User receiving tokens (output)
            if (to.toLowerCase() === userAddress.toLowerCase()) {
                if (!outputToken) {
                    outputToken = {
                        address: log.address,
                        amount,
                    };
                }
            }

            // User sending tokens (input)
            if (from.toLowerCase() === userAddress.toLowerCase()) {
                if (!inputToken) {
                    inputToken = {
                        address: log.address,
                        amount,
                    };
                }
            }
        }
    }

    if (!inputToken || !outputToken) {
        throw new Error("Could not find token transfers for this address");
    }

    const inputContract = new ethers.Contract(
        inputToken.address,
        ERC20_ABI,
        provider
    );
    const outputContract = new ethers.Contract(
        outputToken.address,
        ERC20_ABI,
        provider
    );

    const [inputDecimals, outputDecimals] = await Promise.all([
        (inputContract as any).decimals(),
        (outputContract as any).decimals(),
    ]);

    const inputAmount = ethers.formatUnits(inputToken.amount, inputDecimals);
    const outputAmount = ethers.formatUnits(outputToken.amount, outputDecimals);

    const inputNum = parseFloat(inputAmount);
    const outputNum = parseFloat(outputAmount);
    const conversionRate =
        !Number.isFinite(inputNum) || inputNum === 0
            ? "0"
            : (outputNum / inputNum).toFixed(6);
    return {
        inputAmount: inputNum.toString(),
        outputAmount: outputNum.toString(),
        conversionRate,
    };
}

/**
 * Validate Ethereum address format
 * @param address - The address to validate
 * @returns true if valid, false otherwise
 */
export function isValidEthAddress(address: string): boolean {
    return /^0x[a-fA-F0-9]{40}$/.test(address);
}
