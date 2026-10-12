"""Create directory links for isolated security regression tests."""
import os


def directory_link(link, target):
    target.mkdir(parents=True, exist_ok=True)
    if os.name == 'nt':
        # Junctions require no Developer Mode; production code rejects them too.
        import _winapi
        _winapi.CreateJunction(str(target), str(link))
    else:
        link.symlink_to(target, target_is_directory=True)
