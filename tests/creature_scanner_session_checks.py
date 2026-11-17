import struct
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import creature_identity as identity
import otclient_rtti as rtti
import pointer_scan_entities as entities
import scan_creatures as scanner


class ScannerSessionChecks(unittest.TestCase):
    def profile(self, base, missing=False, digest=identity.EXECUTABLE_SHA256):
        module = {'name': scanner.IMAGE_NAME, 'base': base, 'size': 4096}
        def resolve(image, address, name):
            if missing:
                return None
            return {'vtable': address + (0x100 if name == 'Monster' else 0x200)}
        with patch.object(entities, 'enum_modules', return_value=[module]), \
                patch.object(scanner, 'identity_profile', return_value={'executableSha256': digest}), \
                patch.object(rtti, 'read_module_image', return_value=b'image'), \
                patch.object(rtti, 'resolve_class', side_effect=resolve):
            return scanner.resolve_stream_profile(1, 42, base + 0x300)

    def test_profile_rebases_control_and_object_for_each_session(self):
        for base in (0x140000000, 0x7FF700000000):
            profile = self.profile(base)
            self.assertEqual(int(profile['creatureVtable'], 16), base + 0x200)
            self.assertEqual(int(profile['monsterVtable'], 16), base + 0x100)
            self.assertEqual(int(profile['moduleBase'], 16), base)

    def test_missing_rtti_never_falls_back_to_historical_va(self):
        with self.assertRaisesRegex(ValueError, 'RTTI unavailable'):
            self.profile(0x140000000, missing=True)

    def test_unknown_executable_is_blocked(self):
        with self.assertRaisesRegex(ValueError, 'executable identity'):
            self.profile(0x140000000, digest='0' * 64)

    def stream(self, references=1, object_vtable=0x7100):
        player = {'struct_va': '0x1000', 'vtable': '0x7300', 'id': 1,
                  'name': 'Ash', 'pos': {'x': 100, 'y': 100, 'z': 7}, 'creatureType': 0}
        own = {'struct_va': '0x2000', 'vtable': '0x7200', 'id': 2,
               'name': 'Diglett', 'pos': {'x': 101, 'y': 100, 'z': 7}, 'creatureType': 3, 'healthPercent': 100}
        control = struct.pack('<QIIQ', 0x7200, references, 1, object_vtable)
        snapshots = []
        def save(path, value):
            snapshots.append(value)
            raise KeyboardInterrupt
        with patch.object(scanner, 'locate_player', return_value=player), \
                patch.object(scanner, 'resolve_stream_profile', return_value={
                    'creatureVtable': '0x7200', 'monsterVtable': '0x7100'}), \
                patch.object(scanner, 'read_entity', side_effect=lambda handle, address, layout:
                             dict(player if address == 0x1000 else own)), \
                patch.object(scanner, 'read_mem', return_value=control), \
                patch.object(rtti, 'scan_instances', return_value=[0x2000]) as scan, \
                patch('threading.Thread'), patch.object(scanner, '_write_json_atomic', side_effect=save):
            self.assertEqual(scanner.stream_snapshot(1, 42, 'Ash', 'unused.json'), 0)
            scan.assert_called_once_with(1, 0x7200)
        return snapshots[0]

    def test_stream_discovers_own_pokemon_using_resolved_control_vtable(self):
        snapshot = self.stream()
        self.assertEqual(snapshot['creatures'][0]['creatureType'], 3)
        self.assertTrue(snapshot['creatures'][0]['ownershipVerified'])

    def test_expired_control_block_is_not_owned_pokemon(self):
        self.assertEqual(self.stream(references=0)['creatures'], [])

    def test_wrong_object_vtable_is_not_owned_pokemon(self):
        self.assertEqual(self.stream(object_vtable=0xBAD)['creatures'], [])

    def test_invalid_player_does_not_refresh_snapshot_timestamp(self):
        player = {'struct_va': '0x1000', 'vtable': '0x7300', 'id': 1,
                  'name': 'Ash', 'pos': {'x': 100, 'y': 100, 'z': 7}, 'creatureType': 0}
        invalid = {**player, 'pos': {'x': -1, 'y': -1, 'z': 7}}
        with patch.object(scanner, 'locate_player', return_value=player), \
                patch.object(scanner, 'resolve_stream_profile', return_value={
                    'creatureVtable': '0x7200', 'monsterVtable': '0x7100'}), \
                patch.object(scanner, 'read_entity', return_value=invalid), \
                patch.object(rtti, 'scan_instances', return_value=[]), \
                patch('threading.Thread'), patch.object(scanner, '_write_json_atomic') as save, \
                patch.object(scanner.time, 'sleep', side_effect=KeyboardInterrupt):
            self.assertEqual(scanner.stream_snapshot(1, 42, 'Ash', 'unused.json'), 0)
        save.assert_not_called()


if __name__ == '__main__':
    unittest.main()
