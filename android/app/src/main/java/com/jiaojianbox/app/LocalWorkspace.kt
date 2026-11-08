package com.jiaojianbox.app

import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/** Native on-device workspace. No network request is made by these operations. */
object LocalWorkspace {
    private val root get() = File(AppContext.context.filesDir, "offline-workspace").apply { mkdirs() }
    private val data get() = File(root, "workspace.json")
    private val blobs get() = File(root, "files").apply { mkdirs() }
    fun session() = Session("offline://local", "local", "本机工作区")
    private fun empty() = JSONObject().put("format", "jiaojianbox-workspace").put("version", 1).put("workspace_id", UUID.randomUUID().toString()).put("tasks", JSONArray()).put("messages", JSONArray()).put("files", JSONArray()).put("shelf", JSONArray()).put("imports", JSONObject())
    private fun read(): JSONObject = if (data.exists()) JSONObject(data.readText()) else empty().also { save(it) }
    private fun save(value: JSONObject) {
        val tmp=File(root,"workspace.tmp");tmp.writeText(value.toString());check(tmp.renameTo(data)) { "本机数据保存失败" }
    }
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    private fun rows(value: JSONObject, key: String) = value.optJSONArray(key)?.let { a -> List(a.length()) { a.getJSONObject(it) } } ?: emptyList()
    @Synchronized fun snapshot(): Snapshot {
        val value=read()
        return Snapshot(rows(value,"tasks").map { task ->
            val files=rows(value,"files").filter { it.optString("task_id")==task.getString("id") }
            JSONObject(task.toString()).put("attachments",JSONArray(files)).toTask()
        },rows(value,"messages").map { it.toMessage() },rows(value,"files").map { file ->
            val meta=rows(value,"shelf").find { it.optString("file_id")==file.getString("id") }
            JSONObject(file.toString()).put("category",meta?.optString("category")?:"inbox").toShelf()
        })
    }
    @Synchronized fun createTask(title: String, description: String): JSONObject {
        val value=read();val task=JSONObject().put("id",UUID.randomUUID().toString()).put("title",title).put("description",description).put("status","collecting").put("version",1).put("requirements",JSONArray()).put("attachments",JSONArray()).put("updated_at",java.time.Instant.now().toString())
        value.getJSONArray("tasks").put(task);save(value);return task
    }
    @Synchronized fun setStatus(id: String, status: String): JSONObject {
        val value=read();val task=rows(value,"tasks").find { it.getString("id")==id } ?: error("任务不存在")
        task.put("status",status).put("version",task.optInt("version",1)+1);save(value);return task
    }
    @Synchronized fun upload(name: String, bytes: ByteArray): ShelfItem {
        require(bytes.size<=50*1024*1024) { "文件不能超过 50MB" }
        val value=read();val id=UUID.randomUUID().toString();val row=JSONObject().put("id",id).put("name",name.take(180)).put("size",bytes.size).put("sha256",hash(bytes)).put("kind","material").put("category","inbox").put("task_id",JSONObject.NULL)
        val file=File(blobs,id);file.writeBytes(bytes)
        try {value.getJSONArray("files").put(row);value.getJSONArray("shelf").put(JSONObject().put("file_id",id).put("category","inbox"));save(value)}catch(e:Exception){file.delete();throw e}
        return row.toShelf()
    }
    @Synchronized fun exportZip(): File {
        val value=read();val output=File.createTempFile("workspace-", ".zip", AppContext.context.cacheDir)
        try {
            ZipOutputStream(output.outputStream()).use { zip ->
                zip.putNextEntry(ZipEntry("manifest.json"));zip.write(value.toString().toByteArray());zip.closeEntry()
                for (file in rows(value,"files")) {zip.putNextEntry(ZipEntry("files/"+file.getString("id")));File(blobs,file.getString("id")).inputStream().use { it.copyTo(zip) };zip.closeEntry()}
            }
            return output
        } catch(e:Exception) {output.delete();throw e}
    }
    @Synchronized fun importZip(archive: File) {
        require(archive.length()<=256L*1024*1024) { "数据包超过手机迁移上限 256MB" }
        java.util.zip.ZipFile(archive).use { zip ->
        val infos=zip.entries().toList()
        require(infos.size<=10000 && infos.map { it.name }.distinct().size==infos.size && infos.sumOf { it.size }<=512L*1024*1024) { "数据包内容无效或解压后过大" }
        val meta=zip.getEntry("manifest.json")?:error("缺少数据清单")
        require(meta.size<=20L*1024*1024) { "数据清单过大" }
        val source=JSONObject(zip.getInputStream(meta).bufferedReader().use { it.readText() })
        require(source.optString("format")=="jiaojianbox-workspace" && source.optInt("version")==1){"不支持此数据包格式"}
        val value=read();if(source.getString("workspace_id")==value.getString("workspace_id"))return;val imports=value.optJSONObject("imports")?:JSONObject().also { value.put("imports",it) };val origin=source.getString("workspace_id")
        val taskIds=mutableMapOf<String,String>();val staged=mutableListOf<File>()
        fun map(kind: String,id: String): Pair<String,Boolean> {UUID.fromString(id);val key="$origin:$kind:$id";if(imports.has(key))return imports.getString(key) to false;val result=UUID.randomUUID().toString();imports.put(key,result);return result to true}
        try {
            for (item in rows(source,"messages")) {val (id,fresh)=map("messages",item.getString("id"));if(fresh)value.getJSONArray("messages").put(JSONObject(item.toString()).put("id",id))}
            for (item in rows(source,"tasks")) {
                val (id,fresh)=map("tasks",item.getString("id"));taskIds[item.getString("id")]=id
                val linked=imports.optString("$origin:messages:"+item.optString("source_message_id")).takeIf { it.isNotBlank() }
                if(fresh)value.getJSONArray("tasks").put(JSONObject(item.toString()).put("id",id).put("version",1).put("source_message_id",linked?:JSONObject.NULL))
            }
            for (item in rows(source,"files")) {
                val old=item.getString("id");val (id,fresh)=map("files",old);if(!fresh)continue
                val entry=zip.getEntry("files/$old")?:error("附件不完整")
                require(entry.size==item.getLong("size") && entry.size<=50L*1024*1024){"附件大小无效"}
                val file=File(blobs,id);staged.add(file)
                val digest=MessageDigest.getInstance("SHA-256")
                zip.getInputStream(entry).use { src -> file.outputStream().use { dst ->
                    val buffer=ByteArray(65536);var size=0L
                    while(true){val n=src.read(buffer);if(n<0)break;size+=n;require(size<=entry.size){"附件大小无效"};digest.update(buffer,0,n);dst.write(buffer,0,n)}
                }}
                require(digest.digest().joinToString("") { "%02x".format(it) }==item.getString("sha256")){"附件校验失败"}
                val task=taskIds[item.optString("task_id")];value.getJSONArray("files").put(JSONObject(item.toString()).put("id",id).put("task_id",task?:JSONObject.NULL))
                val meta=rows(source,"shelf").find { it.optString("file_id")==old }
                value.getJSONArray("shelf").put(JSONObject().put("file_id",id).put("category",meta?.optString("category")?:"inbox"))
            }
            if(!value.has("llm_settings") && source.has("llm_settings")) {
                val config=JSONObject(source.getJSONObject("llm_settings").toString());config.remove("api_key");value.put("llm_settings",config)
            }
            save(value);staged.clear()
        } finally {staged.forEach { it.delete() }}
        }
    }
}
