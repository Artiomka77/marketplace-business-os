/*
  Fix six bank loan schedules from bank payment schedules as of 2026-07-07.

  Default mode: DRY RUN. No database changes.
  Apply mode: run with APPLY=true.

  Run on server from /opt/avorofin:
    docker compose exec -T app node < scripts/fix-loans-from-bank-schedules.cjs > server-logs/fix-loans-dry-run.json
    docker compose exec -T -e APPLY=true app node < scripts/fix-loans-from-bank-schedules.cjs > server-logs/fix-loans-apply.json
*/

const { Pool } = require("pg");
const crypto = require("crypto");

const APPLY = String(process.env.APPLY || "").toLowerCase() === "true";

const TARGETS = [
  {
    "bankName": "Авто кредит УралСиб",
    "expectedId": "loan_4a576e763f",
    "contractNumber": "9974-503/31148",
    "creditLimit": 3379251.0,
    "currentDebt": 3064221.93,
    "monthlyPayment": 98000,
    "interestRate": 24.4,
    "startDate": null,
    "endDate": "2030-08-12",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-07-13",
        "principalAmount": 40644.48,
        "interestAmount": 57355.52,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2026-08-12",
        "principalAmount": 37362.77,
        "interestAmount": 60637.23,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2026-09-14",
        "principalAmount": 32123.29,
        "interestAmount": 65876.71,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2026-10-12",
        "principalAmount": 42705.88,
        "interestAmount": 55294.12,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2026-11-12",
        "principalAmount": 37666.52,
        "interestAmount": 60333.48,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2026-12-14",
        "principalAmount": 36526.04,
        "interestAmount": 61473.96,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-01-12",
        "principalAmount": 42997.32,
        "interestAmount": 55002.68,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-02-12",
        "principalAmount": 40095.08,
        "interestAmount": 57904.92,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-03-12",
        "principalAmount": 46449.27,
        "interestAmount": 51550.73,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-04-12",
        "principalAmount": 41888.57,
        "interestAmount": 56111.43,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-05-12",
        "principalAmount": 44538.67,
        "interestAmount": 53461.33,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-06-14",
        "principalAmount": 40175.08,
        "interestAmount": 57824.92,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-07-12",
        "principalAmount": 49688.42,
        "interestAmount": 48311.58,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-08-12",
        "principalAmount": 45541.89,
        "interestAmount": 52458.11,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-09-13",
        "principalAmount": 44823.91,
        "interestAmount": 53176.09,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-10-12",
        "principalAmount": 50678.14,
        "interestAmount": 47321.86,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-11-12",
        "principalAmount": 48464.79,
        "interestAmount": 49535.21,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2027-12-13",
        "principalAmount": 49469.13,
        "interestAmount": 48530.87,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-01-12",
        "principalAmount": 52076.98,
        "interestAmount": 45923.02,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-02-14",
        "principalAmount": 48713.27,
        "interestAmount": 49286.73,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-03-13",
        "principalAmount": 57090.28,
        "interestAmount": 40909.72,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-04-12",
        "principalAmount": 55309.95,
        "interestAmount": 42690.05,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-05-12",
        "principalAmount": 56416.16,
        "interestAmount": 41583.84,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-06-13",
        "principalAmount": 54847.44,
        "interestAmount": 43152.56,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-07-12",
        "principalAmount": 59953.38,
        "interestAmount": 38046.62,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-08-14",
        "principalAmount": 56024.55,
        "interestAmount": 41975.45,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-09-12",
        "principalAmount": 62195.62,
        "interestAmount": 35804.38,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-10-12",
        "principalAmount": 62204.9,
        "interestAmount": 35795.1,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-11-13",
        "principalAmount": 61145.6,
        "interestAmount": 36854.4,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2028-12-12",
        "principalAmount": 65782.84,
        "interestAmount": 32217.16,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-01-12",
        "principalAmount": 64885.4,
        "interestAmount": 33114.6,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-02-12",
        "principalAmount": 66174.5,
        "interestAmount": 31825.5,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-03-12",
        "principalAmount": 70493.02,
        "interestAmount": 27506.98,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-04-12",
        "principalAmount": 69006.7,
        "interestAmount": 28993.3,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-05-14",
        "principalAmount": 69547.6,
        "interestAmount": 28452.4,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-06-13",
        "principalAmount": 72720.64,
        "interestAmount": 25279.36,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-07-12",
        "principalAmount": 74973.07,
        "interestAmount": 23026.93,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-08-13",
        "principalAmount": 74194.78,
        "interestAmount": 23805.22,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-09-12",
        "principalAmount": 77170.57,
        "interestAmount": 20829.43,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-10-12",
        "principalAmount": 78718.21,
        "interestAmount": 19281.79,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-11-12",
        "principalAmount": 79706.78,
        "interestAmount": 18293.22,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2029-12-12",
        "principalAmount": 81895.39,
        "interestAmount": 16104.61,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-01-14",
        "principalAmount": 82091.57,
        "interestAmount": 15908.43,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-02-12",
        "principalAmount": 85611.31,
        "interestAmount": 12388.69,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-03-12",
        "principalAmount": 87640.96,
        "interestAmount": 10359.04,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-04-12",
        "principalAmount": 88347.28,
        "interestAmount": 9652.72,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-05-13",
        "principalAmount": 90178.12,
        "interestAmount": 7821.88,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-06-13",
        "principalAmount": 92046.9,
        "interestAmount": 5953.1,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-07-12",
        "principalAmount": 94215.43,
        "interestAmount": 3784.57,
        "totalAmount": 98000.0
      },
      {
        "paymentDate": "2030-08-12",
        "principalAmount": 101003.48,
        "interestAmount": 2093.12,
        "totalAmount": 103096.6
      }
    ]
  },
  {
    "bankName": "Альфа кредит",
    "expectedId": "loan_cf6b9d061f",
    "contractNumber": "F0PDR520S21102002364",
    "creditLimit": 1799000,
    "currentDebt": 367805.41,
    "monthlyPayment": 42000,
    "interestRate": 13.99,
    "startDate": "2021-10-20",
    "endDate": "2027-04-22",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-07-22",
        "principalAmount": 37770.74,
        "interestAmount": 4229.26,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2026-08-24",
        "principalAmount": 37825.56,
        "interestAmount": 4174.44,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2026-09-22",
        "principalAmount": 38751.99,
        "interestAmount": 3248.01,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2026-10-22",
        "principalAmount": 39085.59,
        "interestAmount": 2914.41,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2026-11-23",
        "principalAmount": 39370.69,
        "interestAmount": 2629.31,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2026-12-22",
        "principalAmount": 40054.81,
        "interestAmount": 1945.19,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2027-01-22",
        "principalAmount": 40396.58,
        "interestAmount": 1603.42,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2027-02-22",
        "principalAmount": 40876.57,
        "interestAmount": 1123.43,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2027-03-22",
        "principalAmount": 41423.98,
        "interestAmount": 576.02,
        "totalAmount": 42000.0
      },
      {
        "paymentDate": "2027-04-22",
        "principalAmount": 12248.9,
        "interestAmount": 145.54,
        "totalAmount": 12394.44
      }
    ]
  },
  {
    "bankName": "Сбер ИП - 5 млн",
    "expectedId": "loan_bfec61bbc7",
    "contractNumber": "210201596040-23-1",
    "creditLimit": 5000000,
    "monthlyPayment": 188734.11,
    "currentDebt": 1645873.07,
    "interestRate": null,
    "startDate": null,
    "endDate": "2027-04-09",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-07-09",
        "totalAmount": 188734.11,
        "principalAmount": 151895.28,
        "interestAmount": 36838.83
      },
      {
        "paymentDate": "2026-08-10",
        "totalAmount": 188734.11,
        "principalAmount": 153733.01,
        "interestAmount": 35001.1
      },
      {
        "paymentDate": "2026-09-09",
        "totalAmount": 188734.11,
        "principalAmount": 156500.2,
        "interestAmount": 32233.91
      },
      {
        "paymentDate": "2026-10-09",
        "totalAmount": 188734.11,
        "principalAmount": 160213.6,
        "interestAmount": 28520.51
      },
      {
        "paymentDate": "2026-11-09",
        "totalAmount": 188734.11,
        "principalAmount": 162483.32,
        "interestAmount": 26250.79
      },
      {
        "paymentDate": "2026-12-09",
        "totalAmount": 188734.11,
        "principalAmount": 166022.14,
        "interestAmount": 22711.97
      },
      {
        "paymentDate": "2027-01-11",
        "totalAmount": 189111.35,
        "principalAmount": 168593.53,
        "interestAmount": 20517.82
      },
      {
        "paymentDate": "2027-02-09",
        "totalAmount": 189161.11,
        "principalAmount": 171527.05,
        "interestAmount": 17634.06
      },
      {
        "paymentDate": "2027-03-09",
        "totalAmount": 189161.11,
        "principalAmount": 175558.6,
        "interestAmount": 13602.51
      },
      {
        "paymentDate": "2027-04-09",
        "totalAmount": 190322.13,
        "principalAmount": 179346.34,
        "interestAmount": 10975.79
      }
    ]
  },
  {
    "bankName": "Сбер ИП - 600 тр",
    "expectedId": "loan_b05af6c78b",
    "contractNumber": "210201596040-24-1",
    "creditLimit": 600000,
    "monthlyPayment": 39120,
    "currentDebt": 438022.31,
    "interestRate": null,
    "startDate": null,
    "endDate": "2027-07-30",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-07-30",
        "totalAmount": 39120.0,
        "principalAmount": 29579.51,
        "interestAmount": 9540.49
      },
      {
        "paymentDate": "2026-08-31",
        "totalAmount": 39120.0,
        "principalAmount": 29927.24,
        "interestAmount": 9192.76
      },
      {
        "paymentDate": "2026-09-30",
        "totalAmount": 39120.0,
        "principalAmount": 30579.08,
        "interestAmount": 8540.92
      },
      {
        "paymentDate": "2026-10-30",
        "totalAmount": 39120.0,
        "principalAmount": 31541.66,
        "interestAmount": 7578.34
      },
      {
        "paymentDate": "2026-11-30",
        "totalAmount": 39120.0,
        "principalAmount": 31998.95,
        "interestAmount": 7121.05
      },
      {
        "paymentDate": "2026-12-30",
        "totalAmount": 39120.0,
        "principalAmount": 32925.62,
        "interestAmount": 6194.38
      },
      {
        "paymentDate": "2027-02-01",
        "totalAmount": 39120.0,
        "principalAmount": 33460.2,
        "interestAmount": 5659.8
      },
      {
        "paymentDate": "2027-03-01",
        "totalAmount": 39120.0,
        "principalAmount": 34481.26,
        "interestAmount": 4638.74
      },
      {
        "paymentDate": "2027-03-30",
        "totalAmount": 39120.0,
        "principalAmount": 35097.56,
        "interestAmount": 4022.44
      },
      {
        "paymentDate": "2027-04-30",
        "totalAmount": 39120.0,
        "principalAmount": 35779.28,
        "interestAmount": 3340.72
      },
      {
        "paymentDate": "2027-05-31",
        "totalAmount": 39120.0,
        "principalAmount": 36666.35,
        "interestAmount": 2453.65
      },
      {
        "paymentDate": "2027-06-30",
        "totalAmount": 39120.0,
        "principalAmount": 37383.18,
        "interestAmount": 1736.82
      },
      {
        "paymentDate": "2027-07-30",
        "totalAmount": 39443.21,
        "principalAmount": 38602.42,
        "interestAmount": 840.79
      }
    ]
  },
  {
    "bankName": "Сбер ООО - 5 млн",
    "expectedId": "loan_60debb8fb1",
    "contractNumber": "7703776720-23-1",
    "creditLimit": 5000000,
    "monthlyPayment": 201265.72,
    "currentDebt": 1744975.44,
    "interestRate": null,
    "startDate": null,
    "endDate": "2027-04-27",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-07-27",
        "totalAmount": 201265.72,
        "principalAmount": 160339.97,
        "interestAmount": 40925.75
      },
      {
        "paymentDate": "2026-08-27",
        "totalAmount": 201265.72,
        "principalAmount": 162559.93,
        "interestAmount": 38705.79
      },
      {
        "paymentDate": "2026-09-28",
        "totalAmount": 201265.72,
        "principalAmount": 165721.6,
        "interestAmount": 35544.12
      },
      {
        "paymentDate": "2026-10-27",
        "totalAmount": 201265.72,
        "principalAmount": 169629.03,
        "interestAmount": 31636.69
      },
      {
        "paymentDate": "2026-11-27",
        "totalAmount": 201265.72,
        "principalAmount": 172243.94,
        "interestAmount": 29021.78
      },
      {
        "paymentDate": "2026-12-28",
        "totalAmount": 201265.72,
        "principalAmount": 176167.71,
        "interestAmount": 25098.01
      },
      {
        "paymentDate": "2027-01-27",
        "totalAmount": 201265.72,
        "principalAmount": 178909.79,
        "interestAmount": 22355.93
      },
      {
        "paymentDate": "2027-03-01",
        "totalAmount": 201265.72,
        "principalAmount": 182499.99,
        "interestAmount": 18765.73
      },
      {
        "paymentDate": "2027-03-29",
        "totalAmount": 201265.72,
        "principalAmount": 186529.89,
        "interestAmount": 14735.83
      },
      {
        "paymentDate": "2027-04-27",
        "totalAmount": 202196.11,
        "principalAmount": 190373.59,
        "interestAmount": 11822.52
      }
    ]
  },
  {
    "bankName": "Сбер ООО - 600 р",
    "expectedId": "loan_ffd0c8aa4f",
    "contractNumber": "7703776720-24-1",
    "creditLimit": 600000,
    "monthlyPayment": 34026,
    "currentDebt": 380725.03,
    "interestRate": null,
    "startDate": null,
    "endDate": "2027-08-06",
    "paymentFrequency": "MONTHLY",
    "payments": [
      {
        "paymentDate": "2026-08-07",
        "totalAmount": 34026.0,
        "principalAmount": 25457.08,
        "interestAmount": 8568.92
      },
      {
        "paymentDate": "2026-09-07",
        "totalAmount": 34026.0,
        "principalAmount": 26030.04,
        "interestAmount": 7995.96
      },
      {
        "paymentDate": "2026-10-07",
        "totalAmount": 34026.0,
        "principalAmount": 26854.93,
        "interestAmount": 7171.07
      },
      {
        "paymentDate": "2026-11-09",
        "totalAmount": 34026.0,
        "principalAmount": 27220.31,
        "interestAmount": 6805.69
      },
      {
        "paymentDate": "2026-12-07",
        "totalAmount": 34026.0,
        "principalAmount": 27993.2,
        "interestAmount": 6032.8
      },
      {
        "paymentDate": "2027-01-11",
        "totalAmount": 34026.0,
        "principalAmount": 28462.99,
        "interestAmount": 5563.01
      },
      {
        "paymentDate": "2027-02-08",
        "totalAmount": 34026.0,
        "principalAmount": 29020.94,
        "interestAmount": 5005.06
      },
      {
        "paymentDate": "2027-03-09",
        "totalAmount": 34026.0,
        "principalAmount": 30148.85,
        "interestAmount": 3877.15
      },
      {
        "paymentDate": "2027-04-07",
        "totalAmount": 34026.0,
        "principalAmount": 30391.56,
        "interestAmount": 3634.44
      },
      {
        "paymentDate": "2027-05-07",
        "totalAmount": 34026.0,
        "principalAmount": 31213.11,
        "interestAmount": 2812.89
      },
      {
        "paymentDate": "2027-06-07",
        "totalAmount": 34026.0,
        "principalAmount": 31821.86,
        "interestAmount": 2204.14
      },
      {
        "paymentDate": "2027-07-07",
        "totalAmount": 34026.0,
        "principalAmount": 32586.07,
        "interestAmount": 1439.93
      },
      {
        "paymentDate": "2027-08-06",
        "totalAmount": 34254.27,
        "principalAmount": 33524.09,
        "interestAmount": 730.18
      }
    ]
  }
];

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

function asNumber(value) {
  if (value === null || value === undefined) return null;
  return Number(value);
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function dateOnly(value) {
  if (!value) return null;
  return new Date(value).toISOString().slice(0, 10);
}

function toDbDate(value) {
  if (!value) return null;
  return `${value}T00:00:00.000Z`;
}

function makePaymentId() {
  return `loanpay_bankfix_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function paymentTotals(payments) {
  return {
    count: payments.length,
    principal: round2(payments.reduce((sum, p) => sum + Number(p.principalAmount || 0), 0)),
    interest: round2(payments.reduce((sum, p) => sum + Number(p.interestAmount || 0), 0)),
    total: round2(payments.reduce((sum, p) => sum + Number(p.totalAmount || 0), 0)),
  };
}

function normalizeLoanRow(row) {
  return {
    id: row.id,
    companyName: row.companyName,
    bankName: row.bankName,
    contractNumber: row.contractNumber,
    creditLimit: asNumber(row.creditLimit),
    currentDebt: asNumber(row.currentDebt),
    monthlyPayment: asNumber(row.monthlyPayment),
    interestRate: asNumber(row.interestRate),
    startDate: dateOnly(row.startDate),
    endDate: dateOnly(row.endDate),
    paymentFrequency: row.paymentFrequency,
  };
}

function normalizePaymentRow(row) {
  return {
    id: row.id,
    loanId: row.loanId,
    paymentDate: dateOnly(row.paymentDate),
    principalAmount: asNumber(row.principalAmount),
    interestAmount: asNumber(row.interestAmount),
    totalAmount: asNumber(row.totalAmount),
    paid: row.paid,
  };
}

async function readCurrentState(client) {
  const ids = TARGETS.map((target) => target.expectedId);

  const loansResult = await client.query(
    `
      SELECT
        "id",
        "companyName",
        "bankName",
        "contractNumber",
        "creditLimit",
        "currentDebt",
        "monthlyPayment",
        "interestRate",
        "startDate",
        "endDate",
        "paymentFrequency",
        "createdAt"
      FROM "Loan"
      WHERE "id" = ANY($1::text[])
      ORDER BY "bankName" ASC
    `,
    [ids]
  );

  const paymentsResult = await client.query(
    `
      SELECT
        "id",
        "loanId",
        "paymentDate",
        "principalAmount",
        "interestAmount",
        "totalAmount",
        "paid",
        "createdAt"
      FROM "LoanPayment"
      WHERE "loanId" = ANY($1::text[])
      ORDER BY "loanId" ASC, "paymentDate" ASC
    `,
    [ids]
  );

  const loansById = new Map(loansResult.rows.map((loan) => [loan.id, loan]));
  const paymentsByLoanId = new Map();

  for (const payment of paymentsResult.rows) {
    if (!paymentsByLoanId.has(payment.loanId)) {
      paymentsByLoanId.set(payment.loanId, []);
    }

    paymentsByLoanId.get(payment.loanId).push(payment);
  }

  return { loansById, paymentsByLoanId };
}

function buildSummary(state) {
  const changes = [];
  const errors = [];

  for (const target of TARGETS) {
    const current = state.loansById.get(target.expectedId);

    if (!current) {
      errors.push(`Не найден кредит ${target.bankName} с id ${target.expectedId}`);
      continue;
    }

    if (current.bankName !== target.bankName) {
      errors.push(
        `Защитная проверка не пройдена: id ${target.expectedId} имеет bankName=${current.bankName}, ожидалось ${target.bankName}`
      );
      continue;
    }

    const oldPayments = state.paymentsByLoanId.get(target.expectedId) || [];
    const newTotals = paymentTotals(target.payments);
    const oldTotals = paymentTotals(oldPayments.map(normalizePaymentRow));

    changes.push({
      bankName: target.bankName,
      loanId: target.expectedId,
      companyName: current.companyName,
      old: {
        contractNumber: current.contractNumber,
        creditLimit: asNumber(current.creditLimit),
        currentDebt: asNumber(current.currentDebt),
        monthlyPayment: asNumber(current.monthlyPayment),
        interestRate: asNumber(current.interestRate),
        startDate: dateOnly(current.startDate),
        endDate: dateOnly(current.endDate),
        paymentFrequency: current.paymentFrequency,
        payments: oldTotals,
      },
      next: {
        contractNumber: target.contractNumber,
        creditLimit: target.creditLimit,
        currentDebt: target.currentDebt,
        monthlyPayment: target.monthlyPayment,
        interestRate: target.interestRate,
        startDate: target.startDate,
        endDate: target.endDate,
        paymentFrequency: target.paymentFrequency,
        payments: newTotals,
      },
      delta: {
        currentDebt: round2(target.currentDebt - Number(current.currentDebt || 0)),
        monthlyPayment: round2(target.monthlyPayment - Number(current.monthlyPayment || 0)),
        paymentsCount: target.payments.length - oldPayments.length,
      },
    });
  }

  return { errors, changes };
}

async function applyChanges(client, state) {
  const backup = [];

  for (const target of TARGETS) {
    const current = state.loansById.get(target.expectedId);
    const oldPayments = state.paymentsByLoanId.get(target.expectedId) || [];

    backup.push({
      loan: normalizeLoanRow(current),
      payments: oldPayments.map(normalizePaymentRow),
    });

    await client.query(
      `
        UPDATE "Loan"
        SET
          "contractNumber" = $2,
          "creditLimit" = $3,
          "currentDebt" = $4,
          "monthlyPayment" = $5,
          "interestRate" = $6,
          "startDate" = $7,
          "endDate" = $8,
          "paymentFrequency" = $9
        WHERE "id" = $1
      `,
      [
        target.expectedId,
        target.contractNumber,
        target.creditLimit,
        target.currentDebt,
        target.monthlyPayment,
        target.interestRate,
        toDbDate(target.startDate),
        toDbDate(target.endDate),
        target.paymentFrequency,
      ]
    );

    await client.query(`DELETE FROM "LoanPayment" WHERE "loanId" = $1`, [target.expectedId]);

    for (const payment of target.payments) {
      await client.query(
        `
          INSERT INTO "LoanPayment" (
            "id",
            "loanId",
            "paymentDate",
            "principalAmount",
            "interestAmount",
            "totalAmount",
            "paid",
            "createdAt"
          )
          VALUES ($1, $2, $3, $4, $5, $6, false, NOW())
        `,
        [
          makePaymentId(),
          target.expectedId,
          toDbDate(payment.paymentDate),
          payment.principalAmount,
          payment.interestAmount,
          payment.totalAmount,
        ]
      );
    }
  }

  return backup;
}

async function main() {
  const client = await pool.connect();

  try {
    const state = await readCurrentState(client);
    const summary = buildSummary(state);

    if (summary.errors.length > 0) {
      console.log(
        JSON.stringify(
          {
            mode: APPLY ? "APPLY" : "DRY_RUN",
            applied: false,
            ok: false,
            errors: summary.errors,
          },
          null,
          2
        )
      );
      process.exitCode = 1;
      return;
    }

    const totals = {
      targetLoans: TARGETS.length,
      currentDebt: round2(TARGETS.reduce((sum, target) => sum + target.currentDebt, 0)),
      monthlyPayment: round2(TARGETS.reduce((sum, target) => sum + target.monthlyPayment, 0)),
      futurePayments: round2(
        TARGETS.reduce(
          (sum, target) => sum + target.payments.reduce((inner, payment) => inner + payment.totalAmount, 0),
          0
        )
      ),
      futureInterest: round2(
        TARGETS.reduce(
          (sum, target) => sum + target.payments.reduce((inner, payment) => inner + payment.interestAmount, 0),
          0
        )
      ),
    };

    if (!APPLY) {
      console.log(
        JSON.stringify(
          {
            mode: "DRY_RUN",
            applied: false,
            ok: true,
            generatedAt: new Date().toISOString(),
            message: "Проверка прошла. База не изменена. Для применения запустите с APPLY=true.",
            totals,
            changes: summary.changes,
          },
          null,
          2
        )
      );
      return;
    }

    await client.query("BEGIN");
    const backup = await applyChanges(client, state);
    await client.query("COMMIT");

    console.log(
      JSON.stringify(
        {
          mode: "APPLY",
          applied: true,
          ok: true,
          generatedAt: new Date().toISOString(),
          message: "6 кредитов обновлены. Старые значения и платежи сохранены ниже в backup этого файла.",
          totals,
          changes: summary.changes,
          backup,
        },
        null,
        2
      )
    );
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}

    console.error(error);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
