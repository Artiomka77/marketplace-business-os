/**
 * Narrow read-only Finance source export for FIN_ACCEPT, 19..25 October 2026.
 * Uses existing project pg dependency and scripts/audit/audit_db_ro.mjs.
 * Never loads/edits env files, never changes session/role/database defaults.
 * No synthetic categories, no PLAN-to-Loan conversion, no auditor row filtering.
 * Syntax/local dry checks only were performed by the reviewer; live DB not run.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const args=process.argv.slice(2);
if(args.includes('--help')){
 console.log('node finance_source_ro.mjs --project <existing-project-root> --out <new-evidence-directory>\nRequires DATABASE_URL from the existing approved audit environment. Does not read .env files.');
 process.exit(0);
}
const opt=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:null;};
const projectArg=opt('--project'),outArg=opt('--out');
if(!projectArg||!outArg)throw new Error('REQUIRED_ARGUMENTS_PROJECT_AND_OUT');
const project=path.resolve(projectArg),out=path.resolve(outArg);
const helper=path.join(project,'scripts/audit/audit_db_ro.mjs');
if(!fs.existsSync(helper))throw new Error('EXISTING_READ_ONLY_HELPER_MISSING');
if(!process.env.DATABASE_URL){console.error(JSON.stringify({status:'SOURCE_ACCESS_BLOCKED',code:'DATABASE_URL_NOT_PRESENT_IN_EXISTING_ENVIRONMENT'}));process.exit(2);}
if(fs.existsSync(path.join(out,'FINANCE_SOURCE.json')))throw new Error('OUTPUT_ALREADY_EXISTS_USE_NEW_DIRECTORY');
const require=createRequire(path.join(project,'package.json'));
const {Client}=require('pg');
const {withReadOnlyTx}=await import(pathToFileURL(helper).href);
if(typeof withReadOnlyTx!=='function')throw new Error('READ_ONLY_HELPER_CONTRACT_MISSING');

// A single SELECT gives all arrays one PostgreSQL statement snapshot.
// Loan schedules are complete for the selected companies, including future and stale rows.
const sql=`
WITH selected_loans AS (
 SELECT id, "companyName", "bankName", "creditLimit"::text AS "creditLimit",
        "currentDebt"::text AS "currentDebt", "monthlyPayment"::text AS "monthlyPayment",
        "interestRate"::text AS "interestRate", "startDate", "endDate", "paymentFrequency", "createdAt"
 FROM "Loan" WHERE "companyName" = ANY($1::text[])
), schedules AS (
 SELECT p.id, p."loanId", p."paymentDate", p.paid,
        p."principalAmount"::text AS "principalAmount", p."interestAmount"::text AS "interestAmount",
        p."totalAmount"::text AS "totalAmount", p."createdAt"
 FROM "LoanPayment" p JOIN selected_loans l ON l.id=p."loanId"
), week_transactions AS (
 SELECT f.id, f."companyName", f."operationDate", f."obligationDate", f."operationType",
        f.category, f.subcategory, f.counterparty, f.amount::text AS amount, f.comment,
        f."isInternalTransfer", f."transferGroupId", f."transferDirection",
        f."transactionStatus", f."sourceType", f."sourceId", f."createdAt"
 FROM "FinanceTransaction" f
 WHERE f."companyName" = ANY($1::text[])
   AND f."operationDate" >= $2::timestamp AND f."operationDate" < $3::timestamp
), early_events AS (
 SELECT f.id, f."companyName", f."operationDate", f."transactionStatus", f."sourceType", f."sourceId",
        f.category, f.amount::text AS amount
 FROM "FinanceTransaction" f
 WHERE f."companyName" = ANY($1::text[])
   AND f."sourceType"='LOAN_EARLY_REPAYMENT' AND f."operationDate" < $3::timestamp
), date_column_types AS (
 SELECT table_name, column_name, data_type
 FROM information_schema.columns
 WHERE table_schema=current_schema()
   AND table_name IN ('Loan','LoanPayment','FinanceTransaction','FinanceCategory')
   AND data_type IN ('timestamp without time zone','timestamp with time zone')
), category_catalog AS (
 SELECT id, name, "parentName", "categoryType", "profitTreatment", "isActive", "sortOrder", "createdAt"
 FROM "FinanceCategory"
)
SELECT jsonb_build_object(
 'schemaVersion','FIN_ACCEPT_PRIMARY_FINANCE_V1',
 'capturedAt',CURRENT_TIMESTAMP,
 'timestampEncoding','PostgreSQL JSON timestamp text; preserve raw text. Prisma timestamp-without-time-zone fields are UTC calendar values, never workstation local time.',
 'timestampColumns',COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY d.table_name,d.column_name) FROM date_column_types d),'[]'::jsonb),
 'transactionReadOnly',current_setting('transaction_read_only'),
 'companies',to_jsonb($1::text[]),
 'dateFrom','2026-10-19','dateToInclusive','2026-10-25',
 'loanScheduleCoverage','ALL_ROWS_FOR_SELECTED_LOANS_WITHOUT_CLASSIFICATION_FILTER',
 'categoryCoverage','ALL_CATEGORIES_INCLUDING_INACTIVE_TO_MATCH_CURRENT_CANONICAL_QUERY',
 'financeCategories',COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.id) FROM category_catalog c),'[]'::jsonb),
 'loans',COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM selected_loans l),'[]'::jsonb),
 'loanPayments',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p."loanId",p."paymentDate",p.id) FROM schedules p),'[]'::jsonb),
 'financeTransactionsWeek',COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f."operationDate",f.id) FROM week_transactions f),'[]'::jsonb),
 'earlyRepaymentEvents',COALESCE((SELECT jsonb_agg(to_jsonb(e) ORDER BY e."operationDate",e.id) FROM early_events e),'[]'::jsonb)
) AS payload
`;
const client=new Client({connectionString:process.env.DATABASE_URL,application_name:'fin_accept_source_ro',connectionTimeoutMillis:10000});
try{
 await client.connect();
 const data=await withReadOnlyTx(client,async c=>{
  const result=await c.query(sql,[['ИП Петров','ИП Лебедева'],'2026-10-19T00:00:00','2026-10-26T00:00:00']);
  const payload=result.rows?.[0]?.payload;
  if(!payload||payload.transactionReadOnly!=='on')throw new Error('READ_ONLY_EXPORT_NOT_CONFIRMED');
  return payload;
 },{statementTimeoutMs:60000,lockTimeoutMs:5000});
 const keys=['timestampColumns','financeCategories','loans','loanPayments','financeTransactionsWeek','earlyRepaymentEvents'];
 for(const key of keys)if(!Array.isArray(data[key]))throw new Error('MISSING_ARRAY_'+key);
 fs.mkdirSync(out,{recursive:true});
 const contents=JSON.stringify(data,null,2)+'\n';
 const target=path.join(out,'FINANCE_SOURCE.json');fs.writeFileSync(target,contents,{encoding:'utf8',flag:'wx',mode:0o600});
 const meta={schemaVersion:data.schemaVersion,capturedAt:data.capturedAt,transactionReadOnly:data.transactionReadOnly,
  amounts:'Decimal values exported as text, no rounding or category inference',
  counts:Object.fromEntries(keys.map(k=>[k,data[k].length])),
  sourceSha256:crypto.createHash('sha256').update(contents).digest('hex'),
  querySha256:crypto.createHash('sha256').update(sql).digest('hex'),
  completenessWarnings:data.financeCategories.length===0?['FINANCE_CATEGORY_CATALOG_EMPTY']:[],
  status:data.financeCategories.length===0?'SOURCE_EVIDENCE_INCOMPLETE':'SOURCE_EXPORTED_NOT_YET_RECONCILED'};
 fs.writeFileSync(path.join(out,'SOURCE_MANIFEST.json'),JSON.stringify(meta,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
 console.log(JSON.stringify({status:meta.status,counts:meta.counts,readOnly:meta.transactionReadOnly}));
 if(meta.completenessWarnings.length)process.exitCode=2;
}catch(error){
 // Do not print raw driver errors: they can contain host/account/connection data.
 const code=String(error?.code??error?.name??'SOURCE_EXPORT_FAILED').replace(/[^A-Za-z0-9_-]/g,'').slice(0,80);
 console.error(JSON.stringify({status:'SOURCE_ACCESS_BLOCKED_OR_EXPORT_FAILED',code,detail:'Inspect locally without logging credentials; do not change roles, environment or DB defaults.'}));
 process.exitCode=2;
}finally{await client.end().catch(()=>{});}
