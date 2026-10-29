import type { PublicProject } from "../../../../src/contracts";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

export interface ProjectPickerProps {
  projects: PublicProject[];
  selectedProjectId?: string;
  onSelect: (projectId: string) => void;
}

export function ProjectPicker({ projects, selectedProjectId, onSelect }: ProjectPickerProps) {
  return (
    <div className="w-full max-w-sm space-y-2">
      <Label htmlFor="active-project">Project</Label>
      <Select value={selectedProjectId ?? ""} onValueChange={onSelect}>
        <SelectTrigger id="active-project">
          <SelectValue placeholder="Choose a project" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
