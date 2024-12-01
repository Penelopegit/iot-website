$('#myTable').DataTable({
    paging: true, // Enable pagination
    searching: false, // Enable search
    ordering: true, // Enable sorting
    info: true, // Show information
    lengthChange: true, // Disable the "Show X entries" dropdown
    columns: [
        { data: "dataId", visible: false },
        { data: "Origin" },
        { data: "Sender" },
        { data: "Description" },
        { data: "Quantity" },
        { data: "Price" },
        { data: "Consent" },
        { data: "Download" },
        { data: "Buy" }
    ]
});

$("#myTable tbody").on("click", ".buyBtn", function() {
    const data = $("#myTable").DataTable().row($(this).closest("tr")).data()
    const request = {
        dataId: data.dataId, 
        ownData: data.Origin == "IOTips" ? 'Y' : 'N'
    }
    $.ajax({
        url: `/BuyData`,
        method: "POST",
        contentType: "application/json; charset=utf-8",
        data: JSON.stringify(request),
        success: function() {
          Swal.fire({
            icon: "success",
            title: "Success!",
            text: `Purchase completed!`,
          })
        }, 
        error: function() {
          Swal.fire({
            icon: "error",
            tile: "An Error Occured",
            text: `An error occured during purchase`,
          })
        }
    })
})