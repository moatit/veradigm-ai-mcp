import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { UnityActions } from '../config/unity-endpoints';
import { UnityService } from '../services/unity.service';
import { UnityErrorHandler, UnityMCPError } from '../utils/error-handler';
import { parseMoney, pick, unityRows } from '../utils/unity-rows';

/**
 * Unity Billing Tools (Veradigm PM, read only)
 *
 * - unity_get_account_balance: GetPatientAccountBalance (one row per voucher; summed here)
 * - unity_get_insurance_policy: GetPatientPolicy
 */
export class UnityBillingTools {
  constructor(private unityService: UnityService) {}

  /**
   * Patient balance. Veradigm returns one record per voucher; the caller wants one number.
   */
  async getAccountBalance(args: { patientId: string }): Promise<{
    success: true;
    patientId: string;
    balance: number;
    voucherCount: number;
    message: string;
  }> {
    const action = UnityActions.Billing.GET_ACCOUNT_BALANCE;
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      const response = await this.unityService.executeAction<any>(action, {}, args.patientId, 'PM');
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || 'Failed to get account balance', action);
      }

      const rows = unityRows(response.data);
      let balance = 0;
      let counted = 0;
      for (const row of rows) {
        const amount = parseMoney(
          pick(row, 'PatientBalance', 'PatBalance', 'Balance', 'VoucherBalance', 'BalanceDue', 'AmountDue')
        );
        if (!isNaN(amount)) {
          balance += amount;
          counted++;
        }
      }
      // Rows came back but none had a readable amount: don't guess "$0".
      if (rows.length > 0 && counted === 0) {
        throw UnityErrorHandler.createAPIError('Balance rows had no readable amount', action, {
          fields: Object.keys(rows[0]),
        });
      }
      balance = Math.round(balance * 100) / 100;

      return {
        success: true,
        patientId: args.patientId,
        balance,
        voucherCount: counted,
        message:
          balance > 0
            ? `The current balance on the account is $${balance.toFixed(2)}.`
            : balance < 0
              ? `The account has a credit of $${Math.abs(balance).toFixed(2)}.`
              : 'There is no balance due on the account.',
      };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  /**
   * Insurance on file (GetPatientPolicy). Never reads back full member IDs.
   */
  async getInsurancePolicy(args: { patientId: string }): Promise<{
    success: true;
    patientId: string;
    policies: Array<{ order: string; carrier: string; plan: string; memberIdLast4: string; effectiveDate: string }>;
    total: number;
    message: string;
  }> {
    const action = UnityActions.Billing.GET_PATIENT_POLICY;
    try {
      if (!args.patientId) {
        throw UnityErrorHandler.createValidationError('Patient ID is required');
      }
      const response = await this.unityService.executeAction<any>(action, {}, args.patientId, 'PM');
      if (!response.success) {
        throw UnityErrorHandler.createAPIError(response.error || 'Failed to get insurance policy', action);
      }

      const policies = unityRows(response.data)
        .map((row) => {
          const memberId = pick(row, 'SubscriberID', 'MemberID', 'PolicyNumber', 'InsuredID');
          return {
            order: pick(row, 'COBOrder', 'Order', 'Priority', 'PolicyOrder', 'Sequence'),
            carrier: pick(row, 'CarrierName', 'InsuranceCarrier', 'Carrier', 'PayerName', 'InsuranceName', 'Name'),
            plan: pick(row, 'PlanName', 'Plan', 'GroupName'),
            memberIdLast4: memberId ? memberId.slice(-4) : '',
            effectiveDate: pick(row, 'EffectiveDate', 'StartDate'),
          };
        })
        .filter((p) => p.carrier || p.plan);

      const message =
        policies.length === 0
          ? 'There is no insurance on file for this patient.'
          : `Insurance on file: ${policies
              .map((p) => [p.carrier, p.plan].filter(Boolean).join(', ') + (p.memberIdLast4 ? ` (member ID ending ${p.memberIdLast4})` : ''))
              .join('; ')}.`;

      return { success: true, patientId: args.patientId, policies, total: policies.length, message };
    } catch (error) {
      if (error instanceof UnityMCPError) throw error;
      throw UnityErrorHandler.handleUnknownError(error, action);
    }
  }

  getTools(): Tool[] {
    return [
      {
        name: 'unity_get_account_balance',
        description: 'Get the verified patient\'s current account balance from Veradigm Practice Management (sums all vouchers)',
        inputSchema: {
          type: 'object',
          properties: { patientId: { type: 'string', description: 'Verified patient ID' } },
          required: ['patientId'],
        },
      },
      {
        name: 'unity_get_insurance_policy',
        description: 'Get the insurance on file for the verified patient from Veradigm Practice Management',
        inputSchema: {
          type: 'object',
          properties: { patientId: { type: 'string', description: 'Verified patient ID' } },
          required: ['patientId'],
        },
      },
    ];
  }
}
