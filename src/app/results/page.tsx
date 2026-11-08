import type { Metadata } from "next";
import { ResultsWorkspace } from "@/components/results/ResultsWorkspace";

export const metadata: Metadata = {
  title: "Results and replay · FlyFireFighter",
  description: "Evaluator outcomes, action and approval history, paired-run counts and recorded replays of FlyFireFighter simulation runs.",
};

export default function ResultsPage() {
  return <ResultsWorkspace />;
}
