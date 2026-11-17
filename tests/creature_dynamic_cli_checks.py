import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
import scan_creatures as scanner
import pointer_scan_entities as entities
import pka_live_session as live
import otclient_rtti as rtti


class DynamicScannerChecks(unittest.TestCase):
    def player(self):
        return {'struct_va': '0x9000', 'vtable': '0x8000', 'id': 0x10000001,
                'name': 'Ash', 'pos': {'x': 970, 'y': 1412, 'z': 7},
                'creatureType': 0, 'healthPercent': 100}

    def test_cli_uses_session_discovery_not_historical_addresses(self):
        player = self.player()
        profile = {'creatureVtable': '0x7200', 'monsterVtable': '0x7100'}
        with patch.object(scanner, 'locate_player', return_value=player), \
                patch.object(scanner, 'read_entity', return_value=player), \
                patch.object(scanner, 'resolve_stream_profile', return_value=profile), \
                patch.object(rtti, 'scan_instances', return_value=[]) as scan:
            snapshot = scanner.scan_process(1, 42, 'Ash')
        scan.assert_called_once_with(1, 0x7200)
        self.assertEqual(snapshot['player']['pos']['x'], 970)
        self.assertTrue(snapshot['player']['ownershipVerified'])
        self.assertEqual(snapshot['layout']['identityProfile'], profile)

    def test_module_relative_chain_relocates_player_in_each_session(self):
        for base in (0x140000000, 0x7FF700000000):
            with patch.object(entities, 'enum_modules', return_value=[{'name': scanner.IMAGE_NAME, 'base': base}]), \
                    patch.object(live, 'resolve_chains', return_value={'struct_va': '0x9000'}) as resolve, \
                    patch.object(scanner, 'read_entity', return_value=self.player()), \
                    patch.object(entities, 'locate_by_name') as fallback:
                player = scanner.locate_player(1, 42, 'Ash', scanner.Layout(), scanner.Filters())
            self.assertEqual(resolve.call_args.args[1], base)
            self.assertEqual(player['name'], 'Ash')
            fallback.assert_not_called()

    def test_invalid_player_never_becomes_fabricated_coordinates(self):
        player = self.player()
        player['pos']['x'] = -1
        with patch.object(entities, 'enum_modules', return_value=[{'name': scanner.IMAGE_NAME, 'base': 0x140000000}]), \
                patch.object(live, 'resolve_chains', return_value={'struct_va': '0x9000'}), \
                patch.object(scanner, 'read_entity', return_value=player), \
                patch.object(entities, 'locate_by_name', return_value=0x9000):
            with self.assertRaisesRegex(ValueError, 'player'):
                scanner.locate_player(1, 42, 'Ash', scanner.Layout(), scanner.Filters())


if __name__ == '__main__':
    unittest.main()
