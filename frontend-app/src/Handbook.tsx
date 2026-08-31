/**
 * In-app handbook — placeholder for now. Reachable from Sideband's help
 * button, same opened/onClose Modal convention as UserAdmin.tsx.
 */
import { Modal, Text } from '@mantine/core'

export default function Handbook({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  return (
    <Modal opened={opened} onClose={onClose} title="Handbuch" centered size="lg">
      <Text c="dimmed" size="sm" fs="italic">
        Noch keine Inhalte.
      </Text>
    </Modal>
  )
}
