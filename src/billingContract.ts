import { ethers, formatEther } from "ethers";
import { BillingData, LatestBillingStatus, PaymentStatus } from "./types";
import { BILLING_CONTRACT_ABI, ROLE_MODIFIER_ABI } from "./abis";

interface BillingInput {
  addresses: `0x${string}`[];
  due: bigint[];
  newPrice: bigint;
}

export class BillingContract {
  readonly contract: ethers.Contract;
  readonly roleContract: ethers.Contract;
  private roleKey?: string;
  fineAmount: bigint;

  constructor(
    address: string,
    signer: ethers.Wallet,
    fineAmount: bigint,
    roleKey?: string,
  ) {
    this.contract = new ethers.Contract(address, BILLING_CONTRACT_ABI, signer);
    this.roleContract = new ethers.Contract(
      "0xa2f93c12E697ABC34770CFAB2def5532043E26e9",
      ROLE_MODIFIER_ABI,
      signer,
    );
    this.roleKey = roleKey;
    if (!roleKey) {
      console.warn(
        `No ROLE_KEY provided, executing transactions as ${signer.address}`,
      );
    }
    this.fineAmount = fineAmount;
  }

  static fromEnv(): BillingContract {
    const {
      RPC_URL,
      BILLER_PRIVATE_KEY,
      BILLING_CONTRACT_ADDRESS,
      ROLE_KEY,
      FINE_FEE,
    } = process.env;
    const provider = new ethers.JsonRpcProvider(RPC_URL!);
    const signer = new ethers.Wallet(BILLER_PRIVATE_KEY!, provider);
    const fineAmount = FINE_FEE ? BigInt(FINE_FEE) : 0n;
    return new BillingContract(
      BILLING_CONTRACT_ADDRESS!,
      signer,
      fineAmount,
      ROLE_KEY,
    );
  }

  async updatePaymentDetails(billingData: BillingData): Promise<string> {
    try {
      const { addresses, due, newPrice } = transformBillingData(billingData);
      const tx = await this.contract.bill(addresses, due, newPrice);
      await tx.wait();
      console.log("Transaction successful:", tx);
      return tx.hash;
    } catch (error) {
      console.error("Transaction failed:", error);
      throw error;
    }
  }

  async processPaymentStatuses(
    paymentStatuses: LatestBillingStatus[],
  ): Promise<string[]> {
    const unpaidRecords = paymentStatuses.filter((record) => {
      const { account, status, paidAmount, billedAmount } = record;
      if (status == PaymentStatus.UNPAID) {
        const owing = billedAmount - paidAmount;
        console.info(`unpaid bill: ${account} owes ${formatEther(owing)} ETH`);
        return true;
      } else if (status == PaymentStatus.OVERPAID) {
        const over = paidAmount - billedAmount;
        console.warn(
          `overpaid bill: ${account} overpaid by ${formatEther(over)}`,
        );
        return false;
      }
      return false;
    });
    // These drafts must be processed sequentially
    // Otherwise the owner account nonce will not be incremented.
    const resultHashes = [];
    for (const rec of unpaidRecords) {
      console.log(`Executing draft for ${rec.account}...`);
      const draftHash = await this.draft(
        rec.account,
        rec.billedAmount - rec.paidAmount,
      );
      resultHashes.push(draftHash);
      if (this.fineAmount > 0) {
        console.log(`Executing fine for ${rec.account}...`);
        const fineHash = await this.fine(rec.account, this.fineAmount);
        resultHashes.push(fineHash);
      }
    }
    return resultHashes;
  }

  async draft(account: `0x${string}`, amount: bigint): Promise<string> {
    try {
      let tx: ethers.ContractTransactionResponse;
      if (this.roleKey) {
        tx = await this.execWithRole(
          this.contract.interface.encodeFunctionData("draft", [
            account,
            amount,
          ]),
          this.roleKey,
        );
      } else {
        tx = await this.contract.draft(account, amount);
      }
      await tx.wait();
      return tx.hash;
    } catch (error) {
      console.error("Draft Transaction failed:", error);
      throw error;
    }
  }

  async fine(account: `0x${string}`, amount: bigint): Promise<string> {
    try {
      let tx: ethers.ContractTransactionResponse;
      // Fee Recipient is MEVBlockerFeeTill Contract.
      const feeRecipient = await this.contract.getAddress();
      if (this.roleKey) {
        tx = await this.execWithRole(
          this.contract.interface.encodeFunctionData("fine", [
            account,
            amount,
            feeRecipient,
          ]),
          this.roleKey,
        );
      } else {
        tx = await this.contract.fine(account, amount, feeRecipient);
      }
      await tx.wait();
      return tx.hash;
    } catch (error) {
      console.error("Fine Transaction failed:", error);
      throw error;
    }
  }

  async execWithRole(
    data: string,
    roleKey: string,
  ): Promise<ethers.ContractTransactionResponse> {
    return this.roleContract.execTransactionWithRole(
      this.contract.getAddress(), // to
      0, // value
      data,
      0, // operation
      roleKey,
      true, // shouldRevert
    );
  }
}

export function transformBillingData(billingData: BillingData): BillingInput {
  return {
    addresses: billingData.dueAmounts.map((v) => v.billingAddress),
    due: billingData.dueAmounts.map((v) => v.dueAmountWei),
    newPrice: billingData.periodFee,
  };
}
