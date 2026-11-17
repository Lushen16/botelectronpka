import ctypes
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

sys.path.insert(0, 'tools')
import walker_input as walker


class DiscoveryTests(unittest.TestCase):
    def user(self):
        user = SimpleNamespace()
        for name in ('OpenWindowStationW', 'SetProcessWindowStation', 'OpenDesktopW',
                     'SetThreadDesktop', 'EnumDesktopWindows', 'EnumWindows',
                     'GetWindowThreadProcessId', 'IsWindowVisible', 'GetWindow',
                     'GetWindowTextW', 'GetClientRect', 'CloseWindowStation'):
            setattr(user, name, Mock())
        user.OpenWindowStationW.return_value = 11
        user.SetProcessWindowStation.return_value = True
        user.OpenDesktopW.return_value = 12
        user.SetThreadDesktop.return_value = True
        user.EnumWindows.return_value = True
        user.EnumDesktopWindows.return_value = True
        user.IsWindowVisible.return_value = True
        user.GetWindow.return_value = 0

        def owner(hwnd, pointer):
            pointer._obj.value = 42 if hwnd != 88 else 99
            return 1

        def title(hwnd, buffer, size):
            buffer.value = 'PokeAlliance - Ash' if hwnd != 66 else 'Other'
            return len(buffer.value)

        def rect(hwnd, pointer):
            pointer._obj.right, pointer._obj.bottom = 800, 600
            return True

        user.GetWindowThreadProcessId.side_effect = owner
        user.GetWindowTextW.side_effect = title
        user.GetClientRect.side_effect = rect
        return user

    def test_binding_is_reused_without_opening_more_handles(self):
        user = self.user()
        self.assertEqual(walker.bind_desktop(user), (11, 12))
        self.assertEqual(walker.bind_desktop(user), (11, 12))
        user.OpenWindowStationW.assert_called_once_with('WinSta0', False, 0x37F)
        user.OpenDesktopW.assert_called_once_with('Default', 0, False, 0x1FF)

    def test_desktop_fallback_follows_empty_enumwindows(self):
        user = self.user()
        order = []
        user.EnumWindows.side_effect = lambda callback, parameter: order.append('windows') or True
        user.EnumDesktopWindows.side_effect = lambda desktop, callback, parameter: order.append('desktop') or callback(77, 0)
        self.assertEqual(walker.find_window(user, 42, walker.configure_user(user)), 77)
        self.assertEqual(order, ['windows', 'desktop'])

    def test_wrong_pid_and_title_are_excluded(self):
        user = self.user()
        def enumerate_windows(callback, parameter):
            for hwnd in (88, 66, 77):
                callback(hwnd, 0)
            return True
        user.EnumWindows.side_effect = enumerate_windows
        self.assertEqual(walker.find_window(user, 42, walker.configure_user(user)), 77)
        user.EnumDesktopWindows.assert_not_called()

    def test_station_failure_does_not_open_desktop_in_wrong_station(self):
        user = self.user()
        user.SetProcessWindowStation.return_value = False
        self.assertEqual(walker.bind_desktop(user), (None, None))
        user.CloseWindowStation.assert_called_once_with(11)
        user.OpenDesktopW.assert_not_called()

    def test_failed_desktop_attachment_still_enumerates_explicit_desktop(self):
        user = self.user()
        user.SetThreadDesktop.return_value = False
        user.EnumDesktopWindows.side_effect = lambda desktop, callback, parameter: callback(77, 0)
        self.assertEqual(walker.find_window(user, 42, walker.configure_user(user)), 77)

    def test_no_matching_window_fails_cleanly(self):
        user = self.user()
        with self.assertRaisesRegex(ValueError, 'Falha ao enumerar janelas do cliente'):
            walker.find_window(user, 42, walker.configure_user(user))


if __name__ == '__main__':
    unittest.main()
