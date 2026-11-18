/**
 * Made-up sample data for the simulated Simpro server. Dates are relative to
 * today so "overdue" and "this month" questions give sensible answers.
 */
const day = (offset: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const money = (ex: number) => ({ ExTax: ex, Tax: Math.round(ex * 0.15 * 100) / 100, IncTax: Math.round(ex * 1.15 * 100) / 100 });

export type Row = Record<string, any>;

export const companies: Row[] = [
  { ID: 101, CompanyName: "Harbourview Apartments Body Corp", Phone: "09 555 0101", Email: "manager@harbourview.example", Address: { Address: "12 Quay Street", City: "Auckland", PostalCode: "1010" } },
  { ID: 102, CompanyName: "Greenfield Dairy Ltd", Phone: "07 555 0102", Email: "accounts@greenfield.example", Address: { Address: "455 Waikato Road", City: "Hamilton", PostalCode: "3200" } },
  { ID: 103, CompanyName: "Smith & Sons Builders", Phone: "03 555 0103", Email: "office@smithsons.example", Address: { Address: "8 Trade Lane", City: "Christchurch", PostalCode: "8011" } },
];

export const individuals: Row[] = [
  { ID: 201, GivenName: "Aroha", FamilyName: "Ngata", Phone: "021 555 201", Email: "aroha@example.com", Address: { Address: "3 Kowhai Place", City: "Tauranga" } },
  { ID: 202, GivenName: "James", FamilyName: "Smith", CellPhone: "027 555 202", Email: "james.smith@example.com", Address: { Address: "77 Beach Road", City: "Napier" } },
];

const ref = (c: Row) =>
  c.CompanyName ? { ID: c.ID, CompanyName: c.CompanyName } : { ID: c.ID, GivenName: c.GivenName, FamilyName: c.FamilyName };
const cust = (id: number) => ref([...companies, ...individuals].find((c) => c.ID === id)!);

export const contacts: Record<number, Row[]> = {
  101: [{ ID: 1, GivenName: "Priya", FamilyName: "Patel", Position: "Building Manager", Email: "priya@harbourview.example", CellPhone: "021 555 111" }],
  102: [{ ID: 2, GivenName: "Tom", FamilyName: "Wilson", Position: "Farm Manager", CellPhone: "027 555 222" }],
};

export const sites: Row[] = [
  { ID: 301, Name: "Harbourview - Tower A", Address: { Address: "12 Quay Street", City: "Auckland" }, Customers: [cust(101)] },
  { ID: 302, Name: "Greenfield - Milking Shed", Address: { Address: "455 Waikato Road", City: "Hamilton" }, Customers: [cust(102)] },
  { ID: 303, Name: "Ngata Residence", Address: { Address: "3 Kowhai Place", City: "Tauranga" }, Customers: [cust(201)] },
  { ID: 304, Name: "Smith Beach House", Address: { Address: "77 Beach Road", City: "Napier" }, Customers: [cust(202)] },
];
const site = (id: number) => {
  const s = sites.find((x) => x.ID === id)!;
  return { ID: s.ID, Name: s.Name };
};

export const employees: Row[] = [
  { ID: 1, Name: "Mere Thompson" },
  { ID: 2, Name: "Dave Clarke" },
  { ID: 3, Name: "Sam Lee" },
];
export const contractors: Row[] = [{ ID: 50, Name: "Southern Sparkies Ltd" }];

export const jobs: Row[] = [
  { ID: 1001, Name: "Tower A switchboard upgrade", Customer: cust(101), Site: site(301), Stage: "Progress", Status: { ID: 1, Name: "Work in progress" }, DateIssued: day(-20), Total: money(18500), Totals: { MaterialsCost: { Estimate: 7200, Actual: 6900 }, ResourcesCost: { Estimate: 5100, Actual: 5600 }, GrossMargin: { Estimate: 33.5, Actual: 32.4 } }, Description: "<p>Replace main switchboard.</p><ul><li>Level 1</li><li>Level 2</li></ul>" },
  { ID: 1002, Name: "Milking shed pump repair", Customer: cust(102), Site: site(302), Stage: "Complete", Status: { ID: 2, Name: "Ready to invoice" }, DateIssued: day(-12), Total: money(2400), Totals: { MaterialsCost: { Estimate: 900, Actual: 950 }, ResourcesCost: { Estimate: 700, Actual: 820 } } },
  { ID: 1003, Name: "Heat pump install", Customer: cust(201), Site: site(303), Stage: "Pending", Status: { ID: 3, Name: "Awaiting parts" }, DateIssued: day(-3), Total: money(4300) },
  { ID: 1004, Name: "Beach house rewire", Customer: cust(202), Site: site(304), Stage: "Invoiced", Status: { ID: 4, Name: "Invoiced" }, DateIssued: day(-60), Total: money(9800) },
  { ID: 1005, Name: "Tower A emergency lighting test", Customer: cust(101), Site: site(301), Stage: "Progress", Status: { ID: 1, Name: "Work in progress" }, DateIssued: day(-5), Total: money(1350) },
];

export const jobSections: Record<number, Row[]> = {
  1001: [{ ID: 1, Name: "Main works" }],
};
export const jobCostCenters: Record<string, Row[]> = {
  "1001/1": [
    { ID: 11, Name: "Switchboard", Total: money(15000) },
    { ID: 12, Name: "Testing & certification", Total: money(3500) },
  ],
};

export const quotes: Row[] = [
  { ID: 2001, Name: "Tower B switchboard upgrade", Customer: cust(101), Site: site(301), Stage: "Complete", Status: { ID: 10, Name: "Sent to customer" }, DateIssued: day(-8), DueDate: day(22), Total: money(21000), IsClosed: false },
  { ID: 2002, Name: "Dairy LED lighting", Customer: cust(102), Site: site(302), Stage: "InProgress", Status: { ID: 11, Name: "Drafting" }, DateIssued: day(-2), DueDate: day(28), Total: money(6400), IsClosed: false },
  { ID: 2003, Name: "Heat pump install", Customer: cust(201), Site: site(303), Stage: "Approved", Status: { ID: 12, Name: "Won" }, DateIssued: day(-15), DueDate: day(15), Total: money(4300), IsClosed: true },
  { ID: 2004, Name: "Extra power points", Customer: cust(202), Site: site(304), Stage: "Complete", Status: { ID: 13, Name: "Lost" }, DateIssued: day(-40), DueDate: day(-10), Total: money(850), IsClosed: true },
];

export const invoices: Row[] = [
  { ID: 3001, Type: "TaxInvoice", Customer: cust(101), Jobs: [{ ID: 1001, Name: "Tower A switchboard upgrade" }], Stage: "Approved", DateIssued: day(-15), DueDate: day(5), Total: money(9250), IsPaid: false },
  { ID: 3002, Type: "TaxInvoice", Customer: cust(202), Jobs: [{ ID: 1004, Name: "Beach house rewire" }], Stage: "Approved", DateIssued: day(-55), DueDate: day(-35), Total: money(9800), IsPaid: false },
  { ID: 3003, Type: "TaxInvoice", Customer: cust(102), Jobs: [{ ID: 1002, Name: "Milking shed pump repair" }], Stage: "Approved", DateIssued: day(-100), DueDate: day(-80), Total: money(1200), IsPaid: true },
  { ID: 3004, Type: "TaxInvoice", Customer: cust(102), Jobs: [{ ID: 1002, Name: "Milking shed pump repair" }], Stage: "Approved", DateIssued: day(-30), DueDate: day(-10), Total: money(1200), IsPaid: false },
];

export const schedules: Row[] = [
  { ID: 5001, Type: "job", Reference: "1001-11", JobID: 1001, Staff: { ID: 1, Name: "Mere Thompson", Type: "employee" }, Date: day(0), Blocks: [{ StartTime: "07:30", EndTime: "15:30", Hrs: 8 }] },
  { ID: 5002, Type: "job", Reference: "1001-11", JobID: 1001, Staff: { ID: 2, Name: "Dave Clarke", Type: "employee" }, Date: day(0), Blocks: [{ StartTime: "07:30", EndTime: "12:00", Hrs: 4.5 }] },
  { ID: 5003, Type: "job", Reference: "1005-21", JobID: 1005, Staff: { ID: 3, Name: "Sam Lee", Type: "employee" }, Date: day(1), Blocks: [{ StartTime: "08:00", EndTime: "11:00", Hrs: 3 }] },
  { ID: 5004, Type: "job", Reference: "1003-31", JobID: 1003, Staff: { ID: 1, Name: "Mere Thompson", Type: "employee" }, Date: day(2), Blocks: [{ StartTime: "09:00", EndTime: "16:00", Hrs: 7 }] },
];

export const notes: Record<string, Row[]> = {
  "jobs/1001": [{ ID: 1, Subject: "Access", Note: "Key from building manager, level 1 office.", DateCreated: day(-19) }],
};
