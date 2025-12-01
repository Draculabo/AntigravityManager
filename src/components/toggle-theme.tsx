import { Moon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toggleTheme } from "@/actions/theme";

export default function ToggleTheme() {
  return (
    <Button onClick={toggleTheme} size="icon">
      <Moon size={16} />
    </Button>
  );
}
