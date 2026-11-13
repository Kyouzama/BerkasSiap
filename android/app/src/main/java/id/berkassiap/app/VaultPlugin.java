package id.berkassiap.app;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;
import androidx.core.content.FileProvider;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Plugin kecil untuk vault BerkasSiap.
 *
 * Vault adalah folder yang dipilih pengguna lewat Storage Access Framework
 * (SAF). Capacitor Filesystem tidak bisa menulis ke folder SAF, jadi plugin
 * ini yang menangani memilih folder, menyimpan, membaca, menghapus, dan
 * membuka berkas di dalamnya.
 */
@CapacitorPlugin(name = "Vault")
public class VaultPlugin extends Plugin {

    private static final int READ_WRITE_FLAGS =
            Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    /** Membuka pemilih folder (SAF) dan menyimpan izin akses permanen. */
    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("cancelled");
            return;
        }

        Uri uri = data.getData();
        // Ambil izin permanen sesuai flag yang benar-benar diberikan penyedia.
        int takeFlags = data.getFlags() & READ_WRITE_FLAGS;
        if (takeFlags == 0) {
            takeFlags = READ_WRITE_FLAGS;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(uri, takeFlags);
        } catch (SecurityException firstError) {
            try {
                getContext().getContentResolver()
                        .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // Penyedia hanya memberi izin sementara; masih bisa dipakai
                // sampai aplikasi ditutup.
            }
        }

        DocumentFile folder = DocumentFile.fromTreeUri(getContext(), uri);
        if (folder == null || !canWriteInto(folder)) {
            call.reject("not_writable");
            return;
        }

        String name = folder.getName();
        if (name == null || name.isEmpty()) {
            name = uri.getLastPathSegment();
        }

        JSObject ret = new JSObject();
        ret.put("uri", uri.toString());
        ret.put("name", name != null ? name : "Vault");
        call.resolve(ret);
    }

    /** Menyimpan berkas base64 ke dalam subfolder vault, dengan nama unik. */
    @PluginMethod
    public void saveFile(PluginCall call) {
        String treeUri = call.getString("treeUri");
        String name = call.getString("name");
        String data = call.getString("data");
        String folderName = call.getString("folder", "");
        String mimeType = call.getString("mimeType", "");

        if (treeUri == null || name == null || data == null) {
            call.reject("missing_arguments");
            return;
        }

        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeUri));
        if (root == null) {
            call.reject("vault_unavailable");
            return;
        }

        DocumentFile target = root;
        if (folderName != null && !folderName.isEmpty()) {
            DocumentFile folder = root.findFile(folderName);
            if (folder == null || !folder.isDirectory()) {
                folder = root.createDirectory(folderName);
            }
            if (folder == null) {
                call.reject("folder_create_failed");
                return;
            }
            target = folder;
        }

        String uniqueName = name;
        int dot = uniqueName.lastIndexOf('.');
        String base = dot > 0 ? uniqueName.substring(0, dot) : uniqueName;
        String extension = dot > 0 ? uniqueName.substring(dot) : "";
        int counter = 2;
        while (target.findFile(uniqueName) != null && counter < 1000) {
            uniqueName = base + "-" + counter + extension;
            counter += 1;
        }

        String resolvedMime = mimeType == null || mimeType.isEmpty()
                ? guessMimeType(uniqueName)
                : mimeType;

        DocumentFile file = target.createFile(resolvedMime, uniqueName);
        if (file == null) {
            call.reject("file_create_failed");
            return;
        }

        OutputStream output = null;
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            output = getContext().getContentResolver().openOutputStream(file.getUri(), "w");
            if (output == null) {
                throw new IllegalStateException("no_stream");
            }
            output.write(bytes);
            output.flush();
            output.close();
            output = null;

            String savedName = file.getName();
            JSObject ret = new JSObject();
            ret.put("uri", file.getUri().toString());
            ret.put("name", savedName != null ? savedName : uniqueName);
            call.resolve(ret);
        } catch (Exception error) {
            if (output != null) {
                try {
                    output.close();
                } catch (Exception ignored) {
                    // Diabaikan.
                }
            }
            file.delete();
            call.reject("write_failed", error);
        }
    }

    /** Membaca isi berkas vault sebagai base64. */
    @PluginMethod
    public void readFile(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("missing_uri");
            return;
        }

        InputStream input = null;
        try {
            input = getContext().getContentResolver().openInputStream(Uri.parse(uriString));
            if (input == null) {
                call.reject("read_failed");
                return;
            }
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int read;
            while ((read = input.read(chunk)) != -1) {
                buffer.write(chunk, 0, read);
            }
            input.close();
            input = null;

            JSObject ret = new JSObject();
            ret.put("data", Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP));
            call.resolve(ret);
        } catch (Exception error) {
            if (input != null) {
                try {
                    input.close();
                } catch (Exception ignored) {
                    // Diabaikan.
                }
            }
            call.reject("read_failed", error);
        }
    }

    /** Mengecek apakah berkas vault masih ada (tidak dihapus manual). */
    @PluginMethod
    public void exists(PluginCall call) {
        String uriString = call.getString("uri");
        boolean found = false;
        if (uriString != null) {
            try {
                DocumentFile file = DocumentFile.fromSingleUri(getContext(), Uri.parse(uriString));
                found = file != null && file.exists();
            } catch (Exception ignored) {
                found = false;
            }
        }
        JSObject ret = new JSObject();
        ret.put("exists", found);
        call.resolve(ret);
    }

    /** Menghapus berkas vault. Tidak gagal jika berkas sudah tidak ada. */
    @PluginMethod
    public void deleteFile(PluginCall call) {
        String uriString = call.getString("uri");
        if (uriString == null) {
            call.reject("missing_uri");
            return;
        }
        try {
            DocumentFile file = DocumentFile.fromSingleUri(getContext(), Uri.parse(uriString));
            if (file != null && file.exists()) {
                file.delete();
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("delete_failed", error);
        }
    }

    /**
     * Membuka berkas dengan aplikasi bawaan Android (ACTION_VIEW).
     * Aplikasi BerkasSiap tetap di latar belakang, sehingga tombol kembali
     * dari penampil berkas mengembalikan ke layar sebelumnya, bukan Beranda.
     */
    @PluginMethod
    public void openFile(PluginCall call) {
        String uriString = call.getString("uri");
        String mimeType = call.getString("mimeType", "");
        if (uriString == null) {
            call.reject("missing_uri");
            return;
        }

        final Uri uri;
        try {
            uri = toContentUri(uriString);
        } catch (Exception error) {
            call.reject("invalid_uri", error);
            return;
        }

        final String type = mimeType == null || mimeType.isEmpty() ? "*/*" : mimeType;
        getActivity().runOnUiThread(() -> {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, type);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException error) {
                call.reject("no_app");
            } catch (Exception error) {
                call.reject("open_failed", error);
            }
        });
    }

    /** Pastikan folder benar-benar bisa ditulis sebelum dijadikan vault. */
    private boolean canWriteInto(DocumentFile folder) {
        try {
            DocumentFile probe = folder.createFile("text/plain", ".berkassiap-probe");
            if (probe == null) {
                return false;
            }
            try {
                probe.delete();
            } catch (Exception ignored) {
                // Berkas uji gagal dihapus: bukan masalah untuk penyimpanan.
            }
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private Uri toContentUri(String value) {
        Uri uri = Uri.parse(value);
        if ("file".equals(uri.getScheme())) {
            String path = uri.getPath();
            File file = new File(path != null ? path : "");
            return FileProvider.getUriForFile(
                    getContext(),
                    getContext().getPackageName() + ".fileprovider",
                    file);
        }
        return uri;
    }

    private String guessMimeType(String name) {
        int dot = name.lastIndexOf('.');
        if (dot >= 0 && dot < name.length() - 1) {
            String extension = name.substring(dot + 1).toLowerCase();
            String type = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (type != null) {
                return type;
            }
        }
        return "application/octet-stream";
    }
}
