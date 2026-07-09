export interface AwsAccount {
  id: string;
  name: string;
  email?: string;
}

export const AWS_ACCOUNTS: AwsAccount[] = [
  { id: "999000111222", name: "Clinicanimal", email: "redacted@example.com" },
  { id: "100200300400", name: "Data desarrollo", email: "redacted@example.com" },
  { id: "999900001111", name: "Digital Dev", email: "redacted@example.com" },
  { id: "888899990000", name: "Digital Ecommerce", email: "redacted@example.com" },
  { id: "111222333444", name: "Digital Prod", email: "redacted@example.com" },
  { id: "000011112222", name: "Digital UAT", email: "redacted@example.com" },
  { id: "222333444555", name: "Ecommerce Tiendanimal", email: "redacted@example.com" },
  { id: "111122223333", name: "EKS Dev", email: "redacted@example.com" },
  { id: "333344445555", name: "EKS Prod", email: "redacted@example.com" },
  { id: "444455556666", name: "EKS Tooling", email: "redacted@example.com" },
  { id: "222233334444", name: "EKS UAT", email: "redacted@example.com" },
  { id: "666677778888", name: "Helios UAT", email: "redacted@example.com" },
  { id: "555566667777", name: "HeliosDev", email: "redacted@example.com" },
  { id: "777788889999", name: "HeliosProd", email: "redacted@example.com" },
  { id: "300400500600", name: "infraestructura", email: "redacted@example.com" },
  { id: "200300400500", name: "Iskaypet Data", email: "redacted@example.com" },
  { id: "333444555666", name: "Iskaypet Ecommerce", email: "redacted@example.com" },
  { id: "444555666777", name: "Retail Dev", email: "redacted@example.com" },
  { id: "666777888999", name: "Retail Prod", email: "redacted@example.com" },
  { id: "555666777888", name: "RetailUAT", email: "redacted@example.com" },
  { id: "600700800900", name: "Root Iskaypet", email: "redacted@example.com" },
  { id: "700800900100", name: "Sandbox Backoffice", email: "redacted@example.com" },
  { id: "800900100200", name: "Sandbox Data", email: "redacted@example.com" },
  { id: "900100200300", name: "Sandbox Digital", email: "redacted@example.com" },
  { id: "100300500700", name: "Sandbox Infra&SRE", email: "redacted@example.com" },
  { id: "200400600800", name: "Sandbox Retail", email: "redacted@example.com" },
  { id: "400500600700", name: "SAP", email: "redacted@example.com" },
  { id: "500600700800", name: "Sistemas Tiendanimal", email: "redacted@example.com" },
];

export const AWS_ACCOUNT_NAMES: Record<string, string> = AWS_ACCOUNTS.reduce<Record<string, string>>((acc, item) => {
  acc[item.id] = item.name;
  return acc;
}, {});

export const AWS_ACCOUNT_EMAILS: Record<string, string> = AWS_ACCOUNTS.reduce<Record<string, string>>((acc, item) => {
  if (item.email) {
    acc[item.id] = item.email;
  }
  return acc;
}, {});

export const ALL_AWS_ACCOUNT_IDS: string[] = AWS_ACCOUNTS.map((account) => account.id);
