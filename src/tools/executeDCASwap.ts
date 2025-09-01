/**
 * Execute DCA Swap Tool
 * 
 * This tool handles the preparation of DCA swaps by:
 * 1. Getting swap plans from Ember MCP
 * 2. Preparing transactions for execution via hooks
 * 3. Returning transaction data for secure signing
 */

import type { VibkitToolDefinition } from 'arbitrum-vibekit-core';
import { createSuccessTask, createErrorTask, parseMcpToolResponsePayload } from 'arbitrum-vibekit-core';
import { z } from 'zod';
import type { DCAContext, TokenInfo } from '../context/types.js';
import { formatUnits, parseUnits, type Address, createPublicClient, createWalletClient, http, erc20Abi } from 'viem';
import { arbitrum } from 'viem/chains';

import { withHooks, transactionSigningAfterHook, transactionValidationBeforeHook } from '../hooks/index.js';


// Response schema for Ember MCP - matches the official ember-api schema
const SwapTokensResponseSchema = z.object({
  status: z.string(),
  orderType: z.string(),
  baseToken: z.object({
    chainId: z.string(),
    address: z.string(),
  }),
  quoteToken: z.object({
    chainId: z.string(),
    address: z.string(),
  }),
  transactions: z.array(z.object({
    type: z.string(),
    to: z.string(),
    data: z.string(),
    value: z.string(),
    chainId: z.string(),
    gas: z.string().optional(),
    gasPrice: z.string().optional(),
    maxFeePerGas: z.string().optional(),
    maxPriorityFeePerGas: z.string().optional(),
  })),
  estimation: z.object({
    baseTokenDelta: z.string(),
    quoteTokenDelta: z.string(),
    effectivePrice: z.string(),
    timeEstimate: z.string(),
    expiration: z.string(),
  }).optional(),
  chainId: z.string(),
});

type SwapTokensResponse = z.infer<typeof SwapTokensResponseSchema>;

/**
 * Find token details in the context's token map
 */
function findTokenDetail(
  tokenSymbol: string,
  tokenMap: Record<string, TokenInfo[]>,
  chainId: number = 42161
): TokenInfo | null {
  const upperSymbol = tokenSymbol.toUpperCase();
  const tokens = tokenMap[upperSymbol];
  if (!tokens || tokens.length === 0) return null;
  return tokens.find(token => token.chainId === chainId) || null;
}

/**
 * Safe conversion for decimal amounts to avoid BigInt errors
 */
function safeToHuman(value: string): string {
  return value.replace(/^\+/, '').trim();
}

const ExecuteDCASwapParams = z.object({
  planId: z.string().describe('DCA plan ID to execute'),
  fromToken: z.string().describe('Source token symbol (e.g., USDC)'),
  toToken: z.string().describe('Target token symbol (e.g., ETH)'),
  amount: z.string().describe('Amount to swap in source token units'),
  userAddress: z.string().describe('User wallet address for the swap'),
  slippage: z.string().optional().default('2').describe('Slippage tolerance percentage'),
});

const ROUTER_ADDRESS = '0xce16F69375520ab01377ce7B88f5BA8C48F8D666' as Address;

/**
 * Handle token approvals and transfer from user to executor
 */
async function handleTokenApprovalsAndTransfer(
  context: any,
  fromTokenDetail: TokenInfo,
  amount: string,
  userAddress: string
): Promise<void> {
  if (!context.custom.executeTransaction) {
    throw new Error('Transaction executor not available');
  }

  const executorAddress = context.custom.executeTransaction.executorAddress;
  //console all details of fromtoken

  console.log("From token details:", fromTokenDetail);
  // Use token's actual decimals for all tokens
  let atomicAmount = parseUnits(amount, fromTokenDetail.decimals);
  if (fromTokenDetail.address == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831") {
    atomicAmount = parseUnits(amount, 6);
    console.log("atomic amount", atomicAmount);
  }


  // Create clients for token operations
  const publicClient = createPublicClient({
    chain: arbitrum,
    transport: http(context.custom.config.arbitrumRpcUrl)
  });

  const walletClient = createWalletClient({
    account: context.custom.executeTransaction.account,
    chain: arbitrum,
    transport: http(context.custom.config.arbitrumRpcUrl)
  });

  console.log(`[DCA Swap] 🔍 Checking approvals for ${fromTokenDetail.symbol} at ${fromTokenDetail.address}`);

  // Check executor's approval to router (0xce16F69375520ab01377ce7B88f5BA8C48F8D666)
  const executorApproval = await publicClient.readContract({
    address: fromTokenDetail.address as Address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [executorAddress, ROUTER_ADDRESS],
  });

  console.log(`[DCA Swap] 📋 Executor approval to router: ${formatUnits(executorApproval, fromTokenDetail.decimals)} ${fromTokenDetail.symbol}`);

  // If approval is insufficient, approve unlimited to router
  if (executorApproval < atomicAmount) {
    console.log(`[DCA Swap] 🔓 Approving unlimited ${fromTokenDetail.symbol} to router ${ROUTER_ADDRESS}...`);

    const approveTxHash = await walletClient.writeContract({
      address: fromTokenDetail.address as Address,
      abi: erc20Abi,
      functionName: 'approve',
      args: [ROUTER_ADDRESS, BigInt('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')],
      account: context.custom.executeTransaction.account,
    });

    await publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    console.log(`[DCA Swap] ✅ Router approval transaction confirmed: ${approveTxHash}`);
  } else {
    console.log(`[DCA Swap] ✅ Executor already has sufficient approval to router`);
  }

  // Transfer tokens from user to executor (assumes user has approved executor)
  console.log(`[DCA Swap] 💸 Transferring ${amount} ${fromTokenDetail.symbol} from user to executor...`);

  // Check user's approval to executor first
  const userApproval = await publicClient.readContract({
    address: fromTokenDetail.address as Address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [userAddress as Address, executorAddress],
  });

  console.log("user", userAddress);
  console.log("executor", executorAddress);
  console.log(`[DCA Swap] 📋 User approval to executor: ${formatUnits(userApproval, fromTokenDetail.decimals)} ${fromTokenDetail.symbol}`);

  if (userApproval < atomicAmount) {
    throw new Error(`Insufficient user approval: need ${amount} ${fromTokenDetail.symbol} but user only approved ${formatUnits(userApproval, fromTokenDetail.decimals)}`);
  }

  // Perform the transfer from user to executor
  const transferTxHash = await walletClient.writeContract({
    address: fromTokenDetail.address as Address,
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [userAddress as Address, executorAddress, atomicAmount],
    account: context.custom.executeTransaction.account,
  });

  await publicClient.waitForTransactionReceipt({ hash: transferTxHash });
  console.log(`[DCA Swap] ✅ Transfer transaction confirmed: ${transferTxHash}`);
}

// Base executeDCASwap tool implementation (transaction preparation only)
const baseExecuteDCASwapTool: VibkitToolDefinition<typeof ExecuteDCASwapParams, any, DCAContext, any> = {
  name: 'executeDCASwap',
  description: 'Prepare a DCA swap transaction using Ember MCP for secure execution via hooks',
  parameters: ExecuteDCASwapParams,
  execute: async (args, context) => {
    try {
      console.log(`[DCA Swap] 🔄 Preparing swap for plan ${args.planId}: ${args.amount} ${args.fromToken} → ${args.toToken}`);

      // Validate requirements
      if (!context.custom.executeTransaction) {
        throw new Error('Transaction execution not enabled - PRIVATE_KEY not configured');
      }
      if (!context.custom.mcpClient) {
        throw new Error('Ember MCP client not available');
      }

      // Resolve tokens
      const fromTokenDetail = findTokenDetail(args.fromToken, context.custom.tokenMap);
      console.log("fromtoken details", fromTokenDetail);
      const toTokenDetail = findTokenDetail(args.toToken, context.custom.tokenMap);

      if (!fromTokenDetail) throw new Error(`Could not resolve fromToken "${args.fromToken}"`);
      if (!toTokenDetail) throw new Error(`Could not resolve toToken "${args.toToken}"`);

      console.log(`[DCA Swap] ✅ From: ${fromTokenDetail.symbol} → To: ${toTokenDetail.symbol}`);

      // Check and handle token approvals and transfers
      await handleTokenApprovalsAndTransfer(
        context,
        fromTokenDetail,
        args.amount,
        args.userAddress
      );
      let atomicAmount = parseUnits(args.amount, fromTokenDetail.decimals);
      if (fromTokenDetail.address == "0xaf88d065e77c8cC2239327C5EDb3A432268e5831") {
        atomicAmount = parseUnits(args.amount, 6);
        console.log("atomic amount", atomicAmount);
      }

      // Get swap plan from Ember MCP
      console.log("args.slippage", args.slippage);
      console.log("fromTokenDetail", fromTokenDetail);
      console.log("toTokenDetail", toTokenDetail);
      console.log("args.user", args.userAddress);
      console.log("args.slippage", args.slippage);

      const swapResult = await context.custom.mcpClient.callTool({
        name: 'swapTokens',
        arguments: {
          orderType: 'MARKET_SELL',
          baseToken: {
            chainId: fromTokenDetail.chainId.toString(),
            address: fromTokenDetail.address,
          },
          quoteToken: {
            chainId: toTokenDetail.chainId.toString(),
            address: toTokenDetail.address,
          },
          amount: atomicAmount.toString(),
          recipient: args.userAddress, // Send swapped tokens to user
          slippageTolerance: args.slippage,
        },
      });

      console.log(`[DCA Swap] 🔍 Swap result: ${JSON.stringify(swapResult)}`);
      if (swapResult.isError) {
        throw new Error(`Failed to get swap plan: ${swapResult.content}`);
      }

      // Parse and execute - NOW PROPERLY TYPED
      const parsedResponse: SwapTokensResponse = parseMcpToolResponsePayload(swapResult, SwapTokensResponseSchema);
      const { transactions, estimation } = parsedResponse;

      if (!transactions || transactions.length === 0) {
        throw new Error('No transactions received from swap plan');
      }

      console.log(`[DCA Swap] ✅ Prepared ${transactions.length} transaction(s) for secure execution via hooks`);

      // Calculate amounts - NOW WITH PROPER TYPE SAFETY
      const fromAmountHuman = args.amount;
      let toAmountHuman = '0';
      let exchangeRate = '0';

      if (estimation) {
        toAmountHuman = safeToHuman(estimation.quoteTokenDelta);
        exchangeRate = safeToHuman(estimation.effectivePrice);
        console.log(`[DCA Swap] 📈 Result: ${toAmountHuman} ${args.toToken} at rate ${exchangeRate}`);
      }

      // Return transaction data for withHooks execution
      return {
        transactions,
        planId: args.planId,
        fromToken: args.fromToken,
        toToken: args.toToken,
        fromAmount: fromAmountHuman,
        toAmount: toAmountHuman,
        exchangeRate: exchangeRate,
        userAddress: args.userAddress,
        operation: 'dca-swap'
      };

    } catch (error) {
      console.error('[DCA Swap] ❌ Preparation failed:', error);
      throw error instanceof Error ? error : new Error(`DCA swap preparation failed: ${String(error)}`);
    }
  },
};


export const executeDCASwapTool = withHooks(baseExecuteDCASwapTool, {
  before: transactionValidationBeforeHook,
  after: transactionSigningAfterHook,
});
