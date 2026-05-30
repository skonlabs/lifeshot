import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export function EmailCapture({ size = "md" }: { size?: "md" | "lg" }) {
  const [email, setEmail] = useState("");
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      toast.error("Please enter a valid email address.");
      return;
    }
    toast.success("You're on the list — we'll be in touch.");
    setEmail("");
  };
  const tall = size === "lg" ? "h-12" : "h-11";
  return (
    <form
      onSubmit={onSubmit}
      className={`flex w-full max-w-md flex-col sm:flex-row gap-2 ${
        size === "lg" ? "sm:gap-2" : ""
      }`}
    >
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@yourlife.com"
        className={`${tall} rounded-full bg-paper border-border px-5 text-base flex-1`}
        aria-label="Email address"
      />
      <Button
        type="submit"
        className={`${tall} rounded-full bg-ink text-paper hover:bg-ink/90 px-6 font-medium`}
      >
        Get early access
      </Button>
    </form>
  );
}