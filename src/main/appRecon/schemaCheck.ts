import { Playbook as PlaybookSchema, type Playbook } from '@shared/appRecon'

/** throws if a playbook would not survive being saved and loaded again */
export function PlaybookSchemaCheck(p: Playbook): void {
  PlaybookSchema.parse(p)
}
