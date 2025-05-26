import { type Address, createPublicClient, createWalletClient, formatUnits, http, parseUnits } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import dotenv from 'dotenv';
import { getContract } from 'viem';
import { USDCABI } from '../USDCAbi';
import { signTypedData } from 'viem/accounts';
import { toHex } from 'viem';

dotenv.config();


const mnemonic = process.env.ADMIN_WALLET_MNEMONIC;
console.log('Using mnemonic:', mnemonic ? '***' : 'not set'); // Hide mnemonic in logs
const usdcAddress = process.env.USDC_CONTRACT_ADDRESS as Address;
const rpcUrl = process.env.BASE_RPC_URL;

if (!mnemonic || !usdcAddress || !rpcUrl) {
  throw new Error('Missing required environment variables for blockchain setup');
}

export const adminAccount = mnemonicToAccount(mnemonic);
console.log('Admin account address:', adminAccount.address);


export const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
})
export const walletClient = createWalletClient({
  account: adminAccount,
  chain: base,
  transport: http(rpcUrl),
});

export const USDCContract = getContract({
    address: usdcAddress as `0x${string}`,
    abi: USDCABI,
    client: walletClient,
})


export function getUserDepositAccount(index: number) {
  // Derive a new account for a user using the admin mnemonic and index
  if (!mnemonic) throw new Error('Missing ADMIN_WALLET_MNEMONIC');
  return mnemonicToAccount(mnemonic, { accountIndex: index });
}

export async function getUSDCBalance(address: Address) {
  const contract = getContract({
    address: usdcAddress as `0x${string}`,
    abi: USDCABI,
    client: walletClient,
  });
  return await contract.read.balanceOf([address]);
}

const printAdminBalance = async () => {
    const bal = await getUSDCBalance(adminAccount.address);
    console.log(`Admin USDC balance: ${formatUnits(bal, 6)} USDC`);
}

printAdminBalance()



// EIP-3009: transferWithAuthorization helper (requires off-chain signature from sender)
export async function transferWithAuthorization({
  from,
  to,
  value,
  validAfter,
  validBefore,
  nonce,
  v,
  r,
  s,
}: {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Address;
  v: number;
  r: Address;
  s: Address;
}) {
  const contract = getContract({
    address: usdcAddress as `0x${string}`,
    abi: USDCABI,
    client: walletClient,
  });
  return await contract.write.transferWithAuthorization([
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s,
  ]);
}

/**
 * Sweep all USDC from a deposit account (derived from admin mnemonic) to a destination address using EIP-3009 transferWithAuthorization.
 * @param fromIndex The account index for the deposit wallet (admin=0, users=1,2,...)
 * @param to Address to receive the funds
 * @param amount Amount of USDC to sweep (in smallest unit, e.g. 6 decimals)
 * @param validAfter Valid after timestamp (seconds)
 * @param validBefore Valid before timestamp (seconds)
 * @returns Transaction hash
 */
export async function sweep({
  fromIndex,
  to,
  amount,
  validAfter,
  validBefore,
}: {
  fromIndex: number;
  to: Address;
  amount: bigint;
  validAfter: bigint;
  validBefore: bigint;
}) {
  if (!mnemonic) throw new Error('Missing ADMIN_WALLET_MNEMONIC');
  const fromAccount = mnemonicToAccount(mnemonic, { accountIndex: fromIndex });
  const from = fromAccount.address;
  // Generate a random 32-byte nonce as a hex string and cast to `0x${string}`
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('')}` as `0x${string}`;
  // EIP-712 domain and types for USDC EIP-3009
  const domain = {
    name: 'USD Coin',
    version: '2',
    chainId: base.id,
    verifyingContract: usdcAddress,
  };
  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  };
  const message = {
    from,
    to,
    value: amount,
    validAfter,
    validBefore,
    nonce,
  };
  // Sign the EIP-712 typed data
  const privateKeyBytes = fromAccount.getHdKey().privateKey;
  if (!privateKeyBytes) throw new Error('Could not derive private key from mnemonic');
  const privateKey = toHex(privateKeyBytes);
  const signature = await signTypedData({
    privateKey,
    domain,
    types,
    primaryType: 'TransferWithAuthorization',
    message,
  });
  // Split signature
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const r = `0x${signature.slice(2, 66)}` as Address;
  const s = `0x${signature.slice(66, 130)}` as Address;
  // Call transferWithAuthorization from admin wallet
  return await transferWithAuthorization({
    from,
    to,
    value: amount,
    validAfter,
    validBefore,
    nonce,
    v,
    r,
    s,
  });
}
