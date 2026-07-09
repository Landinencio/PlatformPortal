import { redirect } from "next/navigation";

export default function AdvisorPage() {
  redirect("/finops?tab=advisor");
}
