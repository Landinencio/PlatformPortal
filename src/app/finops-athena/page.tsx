import { redirect } from "next/navigation";

export default function FinOpsAthenaPage() {
  redirect("/finops?tab=costs");
}
