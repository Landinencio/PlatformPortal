import { redirect } from "next/navigation";

export default function AwsInventoryPage() {
  redirect("/finops?tab=inventory");
}
