import SyntheticDashboard from "@/components/synthetics/synthetic-dashboard";
import { LighthouseTab } from "@/components/synthetics/lighthouse-tab";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

export default function SyntheticsPage() {
    return (
        <div className="container mx-auto py-8">
            <Tabs defaultValue="monitors" className="space-y-6">
                <TabsList>
                    <TabsTrigger value="monitors">Monitores</TabsTrigger>
                    <TabsTrigger value="lighthouse">Lighthouse</TabsTrigger>
                </TabsList>
                <TabsContent value="monitors">
                    <SyntheticDashboard />
                </TabsContent>
                <TabsContent value="lighthouse">
                    <LighthouseTab />
                </TabsContent>
            </Tabs>
        </div>
    );
}
