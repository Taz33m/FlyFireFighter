import type { Metadata } from "next";
import { AboutPage } from "@/components/about/AboutPage";

export const metadata: Metadata = {
  title: "About and credits · FlyFireFighter",
  description: "What is real, simulated and fictional in FlyFireFighter; the FlyVis fly model; what the OpenAI Decisions and Gemini deciders receive; what is saved to MongoDB Atlas; credits and limitations.",
};

export default function About() {
  return <AboutPage />;
}
