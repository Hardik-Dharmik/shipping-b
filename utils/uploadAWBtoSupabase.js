const uploadAwbToSupabase = async (supabase, buffer, awb) => {
    const filePath = `orders/${awb}.pdf`;
  
    const { error } = await supabase.storage
      .from('order-documents')
      .upload(filePath, buffer, {
        contentType: 'application/pdf',
        upsert: true
      });
  
    if (error) throw error;
  
    const { data } = supabase.storage
      .from('order-documents')
      .getPublicUrl(filePath);
  
    return data.publicUrl;
  };

module.exports = uploadAwbToSupabase;