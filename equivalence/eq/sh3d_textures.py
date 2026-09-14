import shutil
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from typing import Any

try:
    import javaobj.v2 as javaobj
    HAS_JAVAOBJ = True
except ImportError:
    HAS_JAVAOBJ = False


def _is_java_serialized(zip_file: zipfile.ZipFile) -> bool:
    """Check if the ZIP contains a Java serialized 'Home' file instead of XML."""
    namelist = zip_file.namelist()
    return 'Home' in namelist and not any(n.endswith('.xml') for n in namelist)


def _extract_java_field_value(instance: Any, field_name: str) -> Any | None:
    """Extract a field value from a JavaObject instance by field name."""
    if not hasattr(instance, 'field_data'):
        return None
    for classdesc, fields in instance.field_data.items():
        if hasattr(classdesc, 'fields'):
            for field in classdesc.fields:
                if field.name == field_name:
                    return fields.get(field)
    return None


class Sh3dTextureExtractor:
    """Extract textures from a .sh3d ZIP archive.

    Supports two formats:
    - Newer (SH3D 6+): ZIP with home.xml and textures/ directory
    - Older: ZIP with Java serialized 'Home' file
    """

    def __init__(self, sh3d_path: str):
        self.sh3d_path = Path(sh3d_path)
        self._zip: zipfile.ZipFile | None = None
        self._tree: ET.ElementTree | None = None
        self._java_home: Any | None = None
        self._is_java_format = False

    def __enter__(self):
        self._zip = zipfile.ZipFile(self.sh3d_path, 'r')

        if _is_java_serialized(self._zip):
            if not HAS_JAVAOBJ:
                raise ImportError(
                    "javaobj-py3 is required to parse older .sh3d files. "
                    "Install with: pip install javaobj-py3"
                )
            self._is_java_format = True
            with self._zip.open('Home') as f:
                self._java_home = javaobj.load(f)
        else:
            xml_names = [n for n in self._zip.namelist() if n.endswith('.xml') and not n.startswith('textures/')]
            if not xml_names:
                raise ValueError(f"No XML found in {self.sh3d_path}")
            with self._zip.open(xml_names[0]) as f:
                self._tree = ET.parse(f)
        return self

    def __exit__(self, *args):
        if self._zip:
            self._zip.close()

    def get_texture_map(self) -> dict[str, str]:
        """Return {texture_name: internal_path} from the textures section."""
        if self._is_java_format:
            return self._get_texture_map_java()
        return self._get_texture_map_xml()

    def _get_texture_map_xml(self) -> dict[str, str]:
        root = self._tree.getroot()
        textures = {}
        for tex in root.iter('texture'):
            name = tex.get('name', '')
            image = tex.get('image', '')
            if name and image:
                textures[name] = image
        return textures

    def _get_texture_map_java(self) -> dict[str, str]:
        # In Java format, textures are embedded objects, not file references.
        # The zip may contain texture image files directly (numbered or named).
        textures = {}
        # Collect image files from the zip
        image_exts = {'.png', '.jpg', '.jpeg', '.gif', '.bmp'}
        for name in self._zip.namelist():
            if Path(name).suffix.lower() in image_exts:
                # Use the stem as the texture name
                textures[Path(name).stem] = name
        return textures

    def extract_textures(self, target_dir: Path) -> dict[str, Path]:
        """Extract all texture files to target_dir. Returns {name: extracted_path}."""
        target_dir.mkdir(parents=True, exist_ok=True)
        tex_map = self.get_texture_map()
        extracted = {}

        for name, internal_path in tex_map.items():
            if internal_path in self._zip.namelist():
                out_name = Path(internal_path).name
                out_path = target_dir / out_name
                with self._zip.open(internal_path) as src, open(out_path, 'wb') as dst:
                    shutil.copyfileobj(src, dst)
                extracted[name] = out_path

        return extracted

    def get_wall_textures(self) -> dict[str, dict[str, str | None]]:
        """Return {wall_id: {left: texName|null, right: texName|null}}."""
        if self._is_java_format:
            return self._get_wall_textures_java()
        return self._get_wall_textures_xml()

    def _get_wall_textures_xml(self) -> dict[str, dict[str, str | None]]:
        root = self._tree.getroot()
        result = {}
        for wall in root.iter('wall'):
            wid = wall.get('id', '')
            result[wid] = {
                'left': wall.get('leftSideTexture'),
                'right': wall.get('rightSideTexture'),
            }
        return result

    def _get_wall_textures_java(self) -> dict[str, dict[str, str | None]]:
        result = {}
        walls = _extract_java_field_value(self._java_home, 'walls')
        if walls is None:
            return result
        for wall in walls:
            wid = _extract_java_field_value(wall, 'id') or ''
            left_tex = _extract_java_field_value(wall, 'leftSideTexture')
            right_tex = _extract_java_field_value(wall, 'rightSideTexture')
            result[wid] = {
                'left': _get_texture_name(left_tex),
                'right': _get_texture_name(right_tex),
            }
        return result

    def get_room_textures(self) -> dict[str, dict[str, str | None]]:
        """Return {room_id: {floor: texName|null, ceiling: texName|null}}."""
        if self._is_java_format:
            return self._get_room_textures_java()
        return self._get_room_textures_xml()

    def _get_room_textures_xml(self) -> dict[str, dict[str, str | None]]:
        root = self._tree.getroot()
        result = {}
        for room in root.iter('room'):
            rid = room.get('id', '')
            result[rid] = {
                'floor': room.get('floorTexture'),
                'ceiling': room.get('ceilingTexture'),
            }
        return result

    def _get_room_textures_java(self) -> dict[str, dict[str, str | None]]:
        result = {}
        rooms = _extract_java_field_value(self._java_home, 'rooms')
        if rooms is None:
            return result
        for room in rooms:
            rid = _extract_java_field_value(room, 'id') or ''
            floor_tex = _extract_java_field_value(room, 'floorTexture')
            ceiling_tex = _extract_java_field_value(room, 'ceilingTexture')
            result[rid] = {
                'floor': _get_texture_name(floor_tex),
                'ceiling': _get_texture_name(ceiling_tex),
            }
        return result

    def get_furniture_textures(self) -> dict[str, str | None]:
        """Return {furniture_id: textureName|null}."""
        if self._is_java_format:
            return self._get_furniture_textures_java()
        return self._get_furniture_textures_xml()

    def _get_furniture_textures_xml(self) -> dict[str, str | None]:
        root = self._tree.getroot()
        result = {}
        for item in root.iter('furniture'):
            fid = item.get('id', '')
            result[fid] = item.get('texture')
        return result

    def _get_furniture_textures_java(self) -> dict[str, str | None]:
        result = {}
        furniture = _extract_java_field_value(self._java_home, 'piecesOfFurniture')
        if furniture is None:
            return result
        for item in furniture:
            fid = _extract_java_field_value(item, 'id') or ''
            tex = _extract_java_field_value(item, 'texture')
            result[fid] = _get_texture_name(tex)
        return result


def _get_texture_name(tex_obj: Any) -> str | None:
    """Extract texture name from a Java texture object or return None."""
    if tex_obj is None:
        return None
    name = _extract_java_field_value(tex_obj, 'name')
    return name if name else None
